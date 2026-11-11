import { Suspense } from 'react'

// ~21KB so the completed boundary exceeds the default progressiveChunkSize
// (12800) and gets outlined in the prerendered shell.
const bigText = 'lorem ipsum dolor sit amet '.repeat(800)

export default function Page() {
  return (
    <Suspense fallback={<p>loading</p>}>
      <div>
        <p>large-boundary-start</p>
        <p>{bigText}</p>
        <p>large-boundary-end</p>
      </div>
    </Suspense>
  )
}
