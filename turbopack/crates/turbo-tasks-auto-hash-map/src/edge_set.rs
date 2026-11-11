//! Sets for a task's dependency edges: a flat array of exactly their elements, inflated to a hash
//! table while lookups and changes need one.
//!
//! A flat set stores exactly its elements: no empty buckets, control bytes or power-of-two rounding
//! as in a hash table. Lookups and removals scan it. The callers decide when a large set should
//! be a hash table instead, with [`EdgeSet::inflate`], and when it should be flat again, with
//! [`EdgeSet::shrink_to_fit`]: they know whether the owning task is executing, whether a batch of
//! changes is coming, and when it is done.
//!
//! The two kinds differ in how they add an element:
//! * [`ForwardEdgeSet`] (a task's own edges): [`EdgeSet::insert`] deduplicates. Only the owning
//!   task inserts, while it executes, so inserting into a large array inflates it first; the task's
//!   completion flattens it again.
//! * [`ReverseEdgeSet`] (the edges into a task): the callers only add an element that isn't in the
//!   set yet (an edge is only added when its forward edge is new), so [`EdgeSet::insert`] just
//!   appends. Debug builds check this where it is cheap.
//!
//! # Representation
//! * Up to `INLINE` elements are stored inline.
//! * Past that, the elements live in a heap allocation behind a thin pointer, after a header
//!   holding the capacity, growing by 1.5x.
//! * Or, while inflated, in a boxed hash table.
//!
//! The encoded form (the length, then the elements) is the same as an [`AutoSet`]'s.
//!
//! [`AutoSet`]: crate::AutoSet

use std::{
    alloc::{self, Layout},
    fmt::{self, Debug},
    hash::{BuildHasherDefault, Hash},
    marker::PhantomData,
    mem::{ManuallyDrop, MaybeUninit},
    ptr::{self, NonNull},
    slice,
};

use bincode::{
    Decode, Encode,
    de::Decoder,
    enc::Encoder,
    error::{DecodeError, EncodeError},
    impl_borrow_decode,
};
use rustc_hash::FxHasher;
use shrink_to_fit::ShrinkToFit;

/// The hash table form. A map, as only hashbrown's maps report their allocation size.
type Table<T> = hashbrown::HashMap<T, (), BuildHasherDefault<FxHasher>>;

/// Set in [`EdgeSet::len`] while the elements live in a heap array.
const SPILLED: u32 = 1 << 31;
/// Set in [`EdgeSet::len`] while the elements live in a hash table.
const HASHED: u32 = 1 << 30;
/// The largest number of elements a set can hold.
const MAX_LEN: usize = (HASHED - 1) as usize;
/// An array of at most this many elements is scanned rather than inflated.
const MAX_SCANNED_LEN: usize = 32;

/// How an [`EdgeSet`] adds elements, see the module docs.
pub trait EdgeSetKind {
    /// Whether [`EdgeSet::insert`] looks for the value first.
    const DEDUPLICATES: bool;
}

/// The [`EdgeSetKind`] of a [`ForwardEdgeSet`].
pub enum Forward {}

impl EdgeSetKind for Forward {
    const DEDUPLICATES: bool = true;
}

/// The [`EdgeSetKind`] of a [`ReverseEdgeSet`].
pub enum Reverse {}

impl EdgeSetKind for Reverse {
    const DEDUPLICATES: bool = false;
}

/// A task's own edges, see the module docs.
pub type ForwardEdgeSet<T, const INLINE: usize = 0> = EdgeSet<T, INLINE, Forward>;
/// The edges into a task, see the module docs.
pub type ReverseEdgeSet<T, const INLINE: usize = 0> = EdgeSet<T, INLINE, Reverse>;

pub struct EdgeSet<T, const INLINE: usize, K> {
    /// The number of inline or heap array elements, with [`SPILLED`] set while they live in a heap
    /// array. Just [`HASHED`] while they live in a hash table.
    len: u32,
    data: Data<T, INLINE>,
    kind: PhantomData<K>,
}

union Data<T, const INLINE: usize> {
    inline: ManuallyDrop<[MaybeUninit<T>; INLINE]>,
    /// Valid while [`SPILLED`]: a [`Header`] followed by `cap` element slots.
    heap: NonNull<Header>,
    /// Valid while [`HASHED`]: a boxed hash table.
    table: NonNull<Table<T>>,
}

#[repr(C)]
struct Header {
    cap: u32,
}

// SAFETY: an `EdgeSet` owns its elements like a `Vec` does.
unsafe impl<T: Send, const INLINE: usize, K> Send for EdgeSet<T, INLINE, K> {}
// SAFETY: shared access only reads the elements.
unsafe impl<T: Sync, const INLINE: usize, K> Sync for EdgeSet<T, INLINE, K> {}

impl<T, const INLINE: usize, K> Default for EdgeSet<T, INLINE, K> {
    fn default() -> Self {
        Self::new()
    }
}

/// An iterator over an [`EdgeSet`]'s elements, in no particular order.
pub enum Iter<'a, T> {
    Slice(slice::Iter<'a, T>),
    Table(hashbrown::hash_map::Keys<'a, T, ()>),
}

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;

    #[inline]
    fn next(&mut self) -> Option<&'a T> {
        match self {
            Iter::Slice(iter) => iter.next(),
            Iter::Table(iter) => iter.next(),
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        match self {
            Iter::Slice(iter) => iter.size_hint(),
            Iter::Table(iter) => iter.size_hint(),
        }
    }
}

impl<T> ExactSizeIterator for Iter<'_, T> {}

impl<T> Clone for Iter<'_, T> {
    fn clone(&self) -> Self {
        match self {
            Iter::Slice(iter) => Iter::Slice(iter.clone()),
            Iter::Table(iter) => Iter::Table(iter.clone()),
        }
    }
}

impl<T, const INLINE: usize, K> EdgeSet<T, INLINE, K> {
    pub const fn new() -> Self {
        Self {
            len: 0,
            data: Data {
                inline: ManuallyDrop::new([const { MaybeUninit::uninit() }; INLINE]),
            },
            kind: PhantomData,
        }
    }

    #[inline]
    const fn is_spilled(&self) -> bool {
        self.len & SPILLED != 0
    }

    #[inline]
    const fn is_hashed(&self) -> bool {
        self.len & HASHED != 0
    }

    /// Whether the elements are in a hash table, i.e. the set is inflated.
    pub const fn is_hash_table(&self) -> bool {
        self.is_hashed()
    }

    fn table(&self) -> Option<&Table<T>> {
        if self.is_hashed() {
            // SAFETY: while hashed, `table` points to a live boxed table owned by `self`. Checked
            // first: the field is only valid while hashed.
            Some(unsafe { self.data.table.as_ref() })
        } else {
            None
        }
    }

    fn table_mut(&mut self) -> Option<&mut Table<T>> {
        if self.is_hashed() {
            // SAFETY: see `table`.
            Some(unsafe { self.data.table.as_mut() })
        } else {
            None
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        match self.table() {
            Some(table) => table.len(),
            None => (self.len & !SPILLED) as usize,
        }
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The layout of an allocation with room for `cap` elements, and the offset of the elements.
    fn layout(cap: usize) -> (Layout, usize) {
        let (layout, offset) = Layout::new::<Header>()
            .extend(Layout::array::<T>(cap).expect("EdgeSet capacity overflow"))
            .expect("EdgeSet capacity overflow");
        (layout.pad_to_align(), offset)
    }

    fn elements_offset() -> usize {
        Self::layout(0).1
    }

    /// The capacity of the heap array, or `0` otherwise.
    fn heap_capacity(&self) -> usize {
        if self.is_spilled() {
            // SAFETY: spilled, so `heap` points to a live allocation starting with a `Header`.
            unsafe { self.data.heap.as_ref().cap as usize }
        } else {
            0
        }
    }

    /// The first inline or heap array element. Must not be hashed.
    fn as_ptr(&self) -> *const T {
        debug_assert!(!self.is_hashed());
        if self.is_spilled() {
            // SAFETY: spilled, and the elements follow the header at `elements_offset`.
            unsafe {
                self.data
                    .heap
                    .as_ptr()
                    .cast::<u8>()
                    .add(Self::elements_offset())
                    .cast::<T>()
            }
        } else {
            // SAFETY: not spilled or hashed, so `inline` is the active field.
            unsafe { self.data.inline.as_ptr().cast::<T>() }
        }
    }

    fn as_mut_ptr(&mut self) -> *mut T {
        debug_assert!(!self.is_hashed());
        if self.is_spilled() {
            // A heap pointer carries the allocation's provenance, so going through `as_ptr` is
            // fine.
            self.as_ptr().cast_mut()
        } else {
            // SAFETY: not spilled, so `inline` is the active field. Derived from `&mut self` so the
            // pointer may write.
            unsafe { (*self.data.inline).as_mut_ptr().cast::<T>() }
        }
    }

    /// The inline or heap array elements. Must not be hashed.
    fn array(&self) -> &[T] {
        // SAFETY: the first `len` elements are initialized.
        unsafe { slice::from_raw_parts(self.as_ptr(), self.len()) }
    }

    pub fn iter(&self) -> Iter<'_, T> {
        match self.table() {
            Some(table) => Iter::Table(table.keys()),
            None => Iter::Slice(self.array().iter()),
        }
    }

    fn allocate(cap: usize) -> NonNull<Header> {
        assert!(cap <= MAX_LEN, "EdgeSet capacity overflow");
        let (layout, _) = Self::layout(cap);
        // SAFETY: the layout has a non-zero size, it contains a `Header`.
        let ptr = unsafe { alloc::alloc(layout) }.cast::<Header>();
        let Some(ptr) = NonNull::new(ptr) else {
            alloc::handle_alloc_error(layout);
        };
        // SAFETY: freshly allocated with room and alignment for a `Header`.
        unsafe { ptr.write(Header { cap: cap as u32 }) };
        ptr
    }

    /// Frees the heap array or hash table, without touching array elements (they are `Copy`, see
    /// the impls). Afterwards `data` dangles until replaced.
    fn deallocate(&mut self) {
        if self.is_hashed() {
            // SAFETY: hashed, so `table` came from `Box::leak` and is owned by `self`.
            drop(unsafe { Box::from_raw(self.data.table.as_ptr()) });
        } else if self.is_spilled() {
            // SAFETY: spilled, so `heap` was allocated with this layout.
            unsafe {
                let (layout, _) = Self::layout(self.heap_capacity());
                alloc::dealloc(self.data.heap.as_ptr().cast(), layout);
            }
        }
    }

    /// Resizes the heap array to `cap` elements.
    ///
    /// # Safety
    /// Must be spilled, and `cap >= len`.
    unsafe fn set_capacity(&mut self, cap: usize) {
        debug_assert!(self.is_spilled() && cap >= self.len());
        assert!(cap <= MAX_LEN, "EdgeSet capacity overflow");
        let (old_layout, _) = Self::layout(self.heap_capacity());
        let (new_layout, _) = Self::layout(cap);
        // SAFETY: allocated with `old_layout`; the new size is non-zero. The header and the first
        // `len <= cap` elements are in the preserved prefix, at the same offsets.
        unsafe {
            let ptr = alloc::realloc(
                self.data.heap.as_ptr().cast(),
                old_layout,
                new_layout.size(),
            );
            let Some(ptr) = NonNull::new(ptr.cast::<Header>()) else {
                alloc::handle_alloc_error(new_layout);
            };
            self.data.heap = ptr;
            self.data.heap.as_mut().cap = cap as u32;
        }
    }

    pub fn clear(&mut self) {
        self.deallocate();
        *self = Self::new();
    }
}

impl<T: Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind> EdgeSet<T, INLINE, K> {
    /// Bytes this set owns on the heap. Excludes heap memory owned by the elements.
    pub fn heap_size(&self) -> usize {
        if let Some(table) = self.table() {
            size_of::<Table<T>>() + table.allocation_size()
        } else if self.is_spilled() {
            Self::layout(self.heap_capacity()).0.size()
        } else {
            0
        }
    }

    /// Entry slots in the heap allocation: the array's capacity or the hash table's buckets.
    pub fn heap_slots(&self) -> usize {
        match self.table() {
            Some(table) => match table.capacity() {
                0 => 0,
                capacity if capacity < 8 => capacity + 1,
                capacity => capacity / 7 * 8,
            },
            None => self.heap_capacity(),
        }
    }

    /// Whether `value` is in the set: a hash lookup while inflated, a scan otherwise.
    pub fn contains(&self, value: &T) -> bool {
        match self.table() {
            Some(table) => table.contains_key(value),
            None => self.array().contains(value),
        }
    }

    /// Switches a large array to a hash table, for a run of lookups and changes. Small arrays
    /// stay arrays: scanning them is about as fast.
    pub fn inflate(&mut self) {
        if !self.is_hashed() && self.len() > MAX_SCANNED_LEN {
            let mut table = Table::with_capacity_and_hasher(self.len(), Default::default());
            table.extend(self.array().iter().map(|&value| (value, ())));
            self.deallocate();
            self.data = Data {
                table: NonNull::from(Box::leak(Box::new(table))),
            };
            self.len = HASHED;
        }
    }

    /// Adds `value`, returning whether it was not in the set yet.
    ///
    /// For a [`ForwardEdgeSet`] this looks for the value first, and inflates a large array before
    /// that: only the owning task inserts, while it executes, so more lookups are coming. For a
    /// [`ReverseEdgeSet`] the caller guarantees the value isn't in the set yet, and this just
    /// appends (and returns `true`).
    pub fn insert(&mut self, value: T) -> bool {
        if K::DEDUPLICATES {
            self.inflate();
            if let Some(table) = self.table_mut() {
                return table.insert(value, ()).is_none();
            }
            if self.array().contains(&value) {
                return false;
            }
        } else {
            self.push(value);
            return true;
        }
        self.push_to_array(value);
        true
    }

    /// Adds `value`, which the caller guarantees isn't in the set yet, without looking for it or
    /// inflating the set. Debug builds check this where it is cheap.
    pub fn push(&mut self, value: T) {
        if let Some(table) = self.table_mut() {
            let new = table.insert(value, ()).is_none();
            debug_assert!(new, "EdgeSet::push of a value that is already in the set");
            return;
        }
        debug_assert!(
            self.len() > MAX_SCANNED_LEN * 2 || !self.array().contains(&value),
            "EdgeSet::push of a value that is already in the set"
        );
        self.push_to_array(value);
    }

    /// Appends `value` to the inline or heap array. Must not be hashed.
    fn push_to_array(&mut self, value: T) {
        let len = self.len();
        if !self.is_spilled() {
            if len >= INLINE {
                self.spill((len * 2).max(4));
            }
        } else if len == self.heap_capacity() {
            // SAFETY: spilled, and the new capacity is larger than `len`.
            unsafe { self.set_capacity((len + len / 2).clamp(4, MAX_LEN.max(len + 1))) };
        }
        // SAFETY: `len` is below the inline or heap capacity, so slot `len` is in bounds.
        unsafe { self.as_mut_ptr().add(len).write(value) };
        self.len += 1;
    }

    /// Moves the inline elements to a new heap array of `cap` elements.
    fn spill(&mut self, cap: usize) {
        debug_assert!(!self.is_spilled() && !self.is_hashed());
        let len = self.len();
        let heap = Self::allocate(cap);
        // SAFETY: the inline elements are initialized; the new allocation has room for `len`.
        unsafe {
            let dst = heap
                .as_ptr()
                .cast::<u8>()
                .add(Self::elements_offset())
                .cast::<T>();
            ptr::copy_nonoverlapping(self.as_ptr(), dst, len);
        }
        self.data = Data { heap };
        self.len |= SPILLED;
    }

    /// Removes `value`, returning whether it was in the set. Scans an array, so callers removing
    /// several values from a large set [`Self::inflate`] it first.
    pub fn remove(&mut self, value: &T) -> bool {
        if let Some(table) = self.table_mut() {
            return table.remove(value).is_some();
        }
        let Some(at) = self.array().iter().position(|v| v == value) else {
            return false;
        };
        let last = self.len() - 1;
        let ptr = self.as_mut_ptr();
        // SAFETY: `at, last < len`: moves the last element into the removed one's slot.
        unsafe { ptr.add(at).write(ptr.add(last).read()) };
        self.len -= 1;
        true
    }

    /// Adds each value, like [`Self::insert`].
    pub fn extend(&mut self, iter: impl IntoIterator<Item = T>) {
        for value in iter {
            self.insert(value);
        }
    }

    /// Keeps only the elements for which `keep` returns true.
    pub fn retain(&mut self, mut keep: impl FnMut(&T) -> bool) {
        if let Some(table) = self.table_mut() {
            table.retain(|value, ()| keep(value));
            return;
        }
        let len = self.len();
        let ptr = self.as_mut_ptr();
        let mut kept = 0;
        for i in 0..len {
            // SAFETY: `i < len`, and `kept <= i`, so this moves initialized elements down.
            unsafe {
                let value = ptr.add(i).read();
                if keep(&value) {
                    ptr.add(kept).write(value);
                    kept += 1;
                }
            }
        }
        self.len = kept as u32 | (self.len & SPILLED);
    }

    /// Flattens a hash table into an exactly sized array, and drops an array's spare capacity,
    /// moving the elements inline if they fit.
    pub fn shrink_to_fit(&mut self) {
        if let Some(table) = self.table() {
            let elements: Vec<T> = table.keys().copied().collect();
            *self = Self::from_vec(elements);
            return;
        }
        if !self.is_spilled() {
            return;
        }
        let len = self.len();
        if len <= INLINE {
            let mut inline = [const { MaybeUninit::uninit() }; INLINE];
            // SAFETY: copies the `len` initialized elements out before freeing the allocation.
            unsafe {
                ptr::copy_nonoverlapping(self.as_ptr(), inline.as_mut_ptr().cast::<T>(), len)
            };
            self.deallocate();
            self.data = Data {
                inline: ManuallyDrop::new(inline),
            };
            self.len = len as u32;
        } else if self.heap_capacity() > len {
            // SAFETY: spilled, and `len <= cap`.
            unsafe { self.set_capacity(len) };
        }
    }

    /// Builds a set from distinct elements, with exactly their capacity.
    fn from_vec(elements: Vec<T>) -> Self {
        let mut set = Self::new();
        let len = elements.len();
        if len > INLINE {
            set.data = Data {
                heap: Self::allocate(len),
            };
            set.len = len as u32 | SPILLED;
        } else {
            set.len = len as u32;
        }
        // SAFETY: the destination has room for `len` elements and doesn't overlap the source.
        unsafe { ptr::copy_nonoverlapping(elements.as_ptr(), set.as_mut_ptr(), len) };
        set
    }
}

impl<T, const INLINE: usize, K> Drop for EdgeSet<T, INLINE, K> {
    fn drop(&mut self) {
        // Array elements are `Copy` (every way to add one requires it), so only the allocation
        // needs freeing; a hash table drops its own elements.
        self.deallocate();
    }
}

impl<T: Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind> Clone for EdgeSet<T, INLINE, K> {
    fn clone(&self) -> Self {
        Self::from_vec(self.iter().copied().collect())
    }
}

impl<T: Debug, const INLINE: usize, K> Debug for EdgeSet<T, INLINE, K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set().entries(self.iter()).finish()
    }
}

impl<T: Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind> PartialEq for EdgeSet<T, INLINE, K> {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().all(|value| other.contains(value))
    }
}

impl<T: Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind> Eq for EdgeSet<T, INLINE, K> {}

impl<T: Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind> FromIterator<T>
    for EdgeSet<T, INLINE, K>
{
    /// Adds each value, like [`EdgeSet::insert`], and shrinks the result to fit.
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        let mut set = Self::new();
        set.extend(iter);
        set.shrink_to_fit();
        set
    }
}

impl<'a, T, const INLINE: usize, K> IntoIterator for &'a EdgeSet<T, INLINE, K> {
    type Item = &'a T;
    type IntoIter = Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<T: Copy, const INLINE: usize, K> IntoIterator for EdgeSet<T, INLINE, K> {
    type Item = T;
    type IntoIter = IntoIter<T, INLINE, K>;

    fn into_iter(self) -> Self::IntoIter {
        IntoIter { set: self, next: 0 }
    }
}

/// An owning iterator over an [`EdgeSet`]'s elements.
pub struct IntoIter<T, const INLINE: usize, K> {
    set: EdgeSet<T, INLINE, K>,
    /// The index of the next element, or the number of elements yielded from a hash table.
    next: usize,
}

impl<T: Copy, const INLINE: usize, K> Iterator for IntoIter<T, INLINE, K> {
    type Item = T;

    fn next(&mut self) -> Option<T> {
        let value = match self.set.table() {
            // `nth` restarts a fresh iterator; fine for the rare owning iteration of an inflated
            // set.
            Some(table) => table.keys().nth(self.next).copied(),
            None => self.set.array().get(self.next).copied(),
        };
        self.next += 1;
        value
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.set.len().saturating_sub(self.next);
        (remaining, Some(remaining))
    }
}

impl<T: Copy, const INLINE: usize, K> ExactSizeIterator for IntoIter<T, INLINE, K> {}

impl<T: Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind> ShrinkToFit
    for EdgeSet<T, INLINE, K>
{
    fn shrink_to_fit(&mut self) {
        EdgeSet::shrink_to_fit(self);
    }
}

impl<T: Encode, const INLINE: usize, K> Encode for EdgeSet<T, INLINE, K> {
    fn encode<E: Encoder>(&self, encoder: &mut E) -> Result<(), EncodeError> {
        self.len().encode(encoder)?;
        for value in self.iter() {
            value.encode(encoder)?;
        }
        Ok(())
    }
}

impl<Context, T: Decode<Context> + Copy + Eq + Hash, const INLINE: usize, K: EdgeSetKind>
    Decode<Context> for EdgeSet<T, INLINE, K>
{
    fn decode<D: Decoder<Context = Context>>(decoder: &mut D) -> Result<Self, DecodeError> {
        let len = usize::decode(decoder)?;
        if len > MAX_LEN {
            return Err(DecodeError::Other("EdgeSet too large"));
        }
        decoder.claim_container_read::<T>(len)?;
        let mut elements = Vec::with_capacity(len);
        for _ in 0..len {
            elements.push(T::decode(decoder)?);
        }
        Ok(Self::from_vec(elements))
    }
}

impl_borrow_decode!(
    EdgeSet<T, INLINE, K>,
    T: Decode<__Context> + Copy + Eq + Hash,
    const INLINE: usize,
    K: EdgeSetKind,
);

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, bound: u32) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 33) % bound as u64) as u32
        }
    }

    fn sorted<const INLINE: usize, K: EdgeSetKind>(set: &EdgeSet<u32, INLINE, K>) -> Vec<u32> {
        let mut elements: Vec<u32> = set.iter().copied().collect();
        elements.sort_unstable();
        elements
    }

    fn random_ops<const INLINE: usize, K: EdgeSetKind>(seed: u64, ops: usize, range: u32) {
        let mut rng = Lcg(seed);
        let mut set = EdgeSet::<u32, INLINE, K>::new();
        let mut model = BTreeSet::new();
        for _ in 0..ops {
            let value = rng.next(range);
            match rng.next(12) {
                0..6 => {
                    if K::DEDUPLICATES {
                        assert_eq!(set.insert(value), model.insert(value));
                    } else if model.insert(value) {
                        // A reverse set's callers only add values that aren't in it yet.
                        assert!(set.insert(value));
                    }
                }
                6..8 => assert_eq!(set.remove(&value), model.remove(&value)),
                8 => {
                    set.retain(|v| v % 7 != value % 7);
                    model.retain(|v| v % 7 != value % 7);
                }
                9 => set.inflate(),
                _ => {
                    if rng.next(4) == 0 {
                        set.shrink_to_fit();
                    }
                }
            }
            assert_eq!(set.contains(&value), model.contains(&value));
            assert_eq!(set.len(), model.len());
            assert!(sorted(&set).iter().eq(model.iter()));
        }
        assert_eq!(set.clone(), set);
        let mut owned: Vec<_> = set.clone().into_iter().collect();
        owned.sort_unstable();
        assert!(owned.iter().eq(model.iter()));
        set.shrink_to_fit();
        assert!(!set.is_hashed());
        if set.len() > INLINE {
            assert_eq!(set.heap_slots(), set.len());
        } else {
            assert!(!set.is_spilled());
        }
        assert!(sorted(&set).iter().eq(model.iter()));
    }

    #[test]
    fn matches_a_btree_set() {
        let ops = if cfg!(miri) { 400 } else { 20_000 };
        for seed in 0..4 {
            random_ops::<0, Forward>(seed, ops, 300);
            random_ops::<3, Forward>(seed, ops, 40);
            random_ops::<6, Forward>(seed, ops, 2000);
            random_ops::<0, Reverse>(seed, ops, 300);
            random_ops::<3, Reverse>(seed, ops, 40);
            random_ops::<4, Reverse>(seed, ops, 2000);
        }
    }

    #[test]
    fn forward_sets_inflate_on_insert_and_flatten_on_shrink() {
        let mut set = ForwardEdgeSet::<u32, 3>::new();
        let n = if cfg!(miri) { 300 } else { 10_000 };
        for i in (0..n).rev() {
            assert!(set.insert(i));
        }
        assert!(set.is_hashed());
        assert!(!set.insert(7));
        set.shrink_to_fit();
        assert!(!set.is_hashed());
        assert_eq!(set.heap_slots(), n as usize);
        // A completed set is looked up by scanning, without inflating.
        assert!(set.contains(&7) && !set.contains(&n));
        assert!(!set.is_hashed());
        // Inserting again, as the task executes again, inflates it.
        assert!(set.insert(n));
        assert!(set.is_hashed());
    }

    #[test]
    fn reverse_sets_append_until_inflated() {
        let mut set = ReverseEdgeSet::<u32, 3>::new();
        let n = if cfg!(miri) { 300 } else { 10_000 };
        for i in 0..n {
            assert!(set.insert(i));
        }
        assert!(!set.is_hashed());
        assert!(set.iter().copied().eq(0..n));
        assert!(set.remove(&5));
        assert!(!set.is_hashed());
        set.inflate();
        assert!(set.is_hashed());
        assert!(set.remove(&6) && !set.contains(&6));
        assert_eq!(set.len(), n as usize - 2);
    }

    #[test]
    fn small_sets_stay_arrays() {
        let mut set: ForwardEdgeSet<u32, 4> = (0..20).collect();
        set.inflate();
        assert!(!set.is_hashed());
        set.retain(|&v| v < 3);
        set.shrink_to_fit();
        assert!(!set.is_spilled());
        assert_eq!(set.heap_size(), 0);
    }

    #[test]
    fn same_size_as_an_auto_set() {
        assert_eq!(size_of::<ForwardEdgeSet<u32, 6>>(), 32);
        assert_eq!(size_of::<ReverseEdgeSet<u32, 4>>(), 24);
        assert_eq!(size_of::<ForwardEdgeSet<u64, 3>>(), 32);
        assert_eq!(size_of::<ReverseEdgeSet<u32, 0>>(), 16);
    }

    #[test]
    fn encodes_like_an_auto_set() {
        let config = bincode::config::standard();
        let set: ForwardEdgeSet<u32, 2> = [5, 3, 9, 1, 7].into_iter().collect();
        let encoded = bincode::encode_to_vec(&set, config).unwrap();
        let auto: crate::AutoSet<u32> = [5, 3, 9, 1, 7].into_iter().collect();
        let (decoded_auto, _): (crate::AutoSet<u32>, _) =
            bincode::decode_from_slice(&encoded, config).unwrap();
        assert_eq!(decoded_auto, auto);
        let from_auto = bincode::encode_to_vec(&auto, config).unwrap();
        let (decoded, _): (ReverseEdgeSet<u32, 2>, _) =
            bincode::decode_from_slice(&from_auto, config).unwrap();
        assert_eq!(decoded.len(), 5);
        assert!([5, 3, 9, 1, 7].iter().all(|v| decoded.contains(v)));
    }
}
