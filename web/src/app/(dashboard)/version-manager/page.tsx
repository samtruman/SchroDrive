"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function LegacyVersionManagerRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace("/media-manager") }, [router])
  return <p className="text-sm text-muted-foreground">Opening Media Manager…</p>
}
