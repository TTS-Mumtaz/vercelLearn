import { Suspense } from 'react'
import { connection } from 'next/server'

async function SlowContent() {
  await connection()
  await new Promise((resolve) => setTimeout(resolve, 500))
  return <p>slow-content-marker</p>
}

export default function Page() {
  return (
    <Suspense fallback={<p>slow-fallback-marker</p>}>
      <SlowContent />
    </Suspense>
  )
}
