"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Link, Search, Plus, Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import { toast } from "sonner"

interface Provider {
  name: string
  id: string
  configured: boolean
  connected: boolean
}

function magnetDisplayName(value: string): string {
  try {
    return new URL(value).searchParams.get("dn")?.trim() || ""
  } catch {
    return ""
  }
}

export default function AddContentPage() {
  const [magnetUrl, setMagnetUrl] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string>("torbox")
  const [intakeMode, setIntakeMode] = useState<"standalone" | "arr">("standalone")
  const [mediaType, setMediaType] = useState<"movie" | "tv">("movie")
  const [identityQuery, setIdentityQuery] = useState("")
  const [identityCandidates, setIdentityCandidates] = useState<any[]>([])
  const [selectedIdentity, setSelectedIdentity] = useState<any>(null)
  const [pendingAddition, setPendingAddition] = useState<{ provider: string; title?: string; magnet: string; mode: "standalone" | "arr"; mediaType: "movie" | "tv" } | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)

  const resolveIdentity = async (query: string, type: "movie" | "tv") => {
    if (!query.trim()) {
      toast.error("Inserisci il titolo da cercare su TMDB")
      return
    }
    setIsSearching(true)
    try {
      const params = new URLSearchParams({ query: query.trim(), type, candidates: "true" })
      const response = await fetch(`/api/metadata/tmdb/resolve?${params}`, { cache: "no-store" })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "TMDB resolution failed")
      const candidates = body.candidates || []
      setIdentityCandidates(candidates)
      // Never silently choose the first TMDB result: localized release names
      // such as "Odissea" can legitimately match several films. Let the user
      // confirm the exact identity whenever candidates are ambiguous.
      setSelectedIdentity(candidates.length === 1
        ? { ...candidates[0], kind: type }
        : candidates.length === 0 && body.resolution?.metadata
          ? { ...body.resolution.metadata, kind: type }
          : null)
      if (candidates.length === 0 && !body.resolution?.metadata) toast.info("Nessun risultato TMDB trovato")
    } catch (error: any) {
      toast.error(error.message || "TMDB resolution failed")
    } finally {
      setIsSearching(false)
    }
  }

  useEffect(() => {
    async function fetchProviders() {
      try {
        const res = await fetch("/api/providers")
        const data = await res.json()
        if (data.ok !== false && data.providers) {
          setProviders(data.providers)
          // AllDebrid is the default provider for the manual intake flow.
          // Keep the first connected provider as a fallback for installations
          // where AllDebrid is not configured.
          const defaultProvider = data.providers.find((p: Provider) => p.id === "alldebrid" && p.connected)
            || data.providers.find((p: Provider) => p.connected)
          if (defaultProvider) {
            setSelectedProvider(defaultProvider.id)
          }
        }
      } catch (error) {
        console.error("Failed to fetch providers:", error)
      } finally {
        setLoading(false)
      }
    }
    fetchProviders()
  }, [])

  const handleAddMagnet = async () => {
    if (!magnetUrl.trim()) {
      toast.error("Please enter a magnet URL")
      return
    }
    
    if (!magnetUrl.startsWith("magnet:")) {
      toast.error("Invalid magnet URL - must start with 'magnet:'")
      return
    }

    const title = magnetDisplayName(magnetUrl)
    setPendingAddition({ provider: selectedProvider, title, magnet: magnetUrl, mode: intakeMode, mediaType })
    setIdentityQuery(title)
    setIdentityCandidates([])
    setSelectedIdentity(null)
    setMagnetUrl("")
    toast.info("Magnet acquisito. Ora conferma l’identità TMDB prima dell’invio.")
    if (title) void resolveIdentity(title, mediaType)
  }

  const handleSearchAndAdd = async () => {
    if (!searchQuery.trim()) {
      toast.error("Please enter a search query")
      return
    }

    setIsSearching(true)
    
    try {
      // First search
      const searchRes = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`)
      const searchData = await searchRes.json()
      
      if (searchData.ok === false) {
        toast.error(searchData.error || "Search failed")
        return
      }
      
      if (!searchData.results || searchData.results.length === 0) {
        toast.error("No results found")
        return
      }

      // Get best result (first one - backend sorts by seeders)
      const best = searchData.results[0]
      
      if (!best.magnetUrl) {
        toast.error("Best result has no magnet URL")
        return
      }

      toast.info(`Found: ${best.title}`)
      
      setPendingAddition({ provider: selectedProvider, title: best.title, magnet: best.magnetUrl, mode: intakeMode, mediaType })
      setIdentityQuery(best.title)
      setIdentityCandidates([])
      setSelectedIdentity(null)
      setSearchQuery("")
      toast.info("Risultato selezionato. Conferma ora l’identità TMDB prima dell’invio.")
      void resolveIdentity(best.title, mediaType)
    } catch (err: any) {
      toast.error(err.message || "Failed to search and add")
    } finally {
      setIsSearching(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Add Content</h1>
          <p className="text-muted-foreground">Loading providers...</p>
        </div>
        <Skeleton className="h-32 max-w-2xl" />
        <Skeleton className="h-48 max-w-2xl" />
      </div>
    )
  }

  const connectedProviders = providers.filter(p => p.connected)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Add Content</h1>
        <p className="text-muted-foreground">Add torrents to your debrid service</p>
      </div>

      <div className="max-w-2xl space-y-6">
        {connectedProviders.length === 0 ? (
          <Card className="border-yellow-500/50 bg-yellow-500/5">
            <CardContent className="py-6">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-yellow-500" />
                <div>
                  <p className="font-medium">No providers connected</p>
                  <p className="text-sm text-muted-foreground">
                    Configure a debrid provider in settings to add content.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Select Provider</CardTitle>
                <CardDescription>Choose which service to add content to</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4">
                  {providers.map((provider) => (
                    <Button
                      key={provider.id}
                      variant={selectedProvider === provider.id ? "default" : "outline"}
                      onClick={() => setSelectedProvider(provider.id)}
                      className="flex-1"
                      disabled={!provider.connected}
                    >
                      {selectedProvider === provider.id && <CheckCircle2 className="mr-2 h-4 w-4" />}
                      {provider.name}
                      {!provider.connected && <span className="ml-2 text-xs">(disconnected)</span>}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link className="h-5 w-5" />
                  Aggiungi e associa contenuto
                </CardTitle>
                <CardDescription>
                  {pendingAddition ? "Step 2: identifica il contenuto con TMDB prima dell’invio." : "Step 1: acquisisci il magnet, poi conferma film o serie e l’identità TMDB."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!pendingAddition && <>
                  <div className="space-y-2">
                    <Label>Modalità di importazione</Label>
                    <div className="flex gap-2">
                      <Button type="button" variant={intakeMode === "standalone" ? "default" : "outline"} onClick={() => setIntakeMode("standalone")} className="flex-1">Standalone</Button>
                      <Button type="button" variant={intakeMode === "arr" ? "default" : "outline"} onClick={() => setIntakeMode("arr")} className="flex-1">Sonarr/Radarr</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {intakeMode === "standalone" ? "SchroDrive organizza il contenuto dopo la conferma TMDB." : "Dopo TMDB il magnet viene consegnato a Sonarr/Radarr con titolo canonico e categoria corretta."}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Tipo di contenuto</Label>
                    <div className="flex gap-2">
                      <Button type="button" aria-pressed={mediaType === "movie"} variant={mediaType === "movie" ? "default" : "outline"} onClick={() => setMediaType("movie")}>Film</Button>
                      <Button type="button" aria-pressed={mediaType === "tv"} variant={mediaType === "tv" ? "default" : "outline"} onClick={() => setMediaType("tv")}>Serie</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      "Questa scelta determina la ricerca TMDB e il percorso Film/Serie."
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="magnet">Magnet URL</Label>
                    <Input
                      id="magnet"
                      placeholder="magnet:?xt=urn:btih:..."
                      value={magnetUrl}
                      onChange={(e) => setMagnetUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddMagnet()}
                    />
                  </div>
                  <Button onClick={handleAddMagnet} disabled={!magnetUrl.trim() || isAdding} className="w-full">
                    {isAdding ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Aggiunta in corso...</>
                    ) : (
                      <><Plus className="mr-2 h-4 w-4" />Aggiungi a {providers.find(p => p.id === selectedProvider)?.name || selectedProvider}</>
                    )}
                  </Button>
                </>}

                {pendingAddition && <div className="space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-primary" />Magnet acquisito, in attesa di conferma TMDB</div>
                  {pendingAddition.title && <p className="text-xs text-muted-foreground">Titolo rilevato dal magnet: <span className="font-medium text-foreground">{pendingAddition.title}</span></p>}
                  <div className="space-y-2">
                    <Label>Tipo di contenuto</Label>
                    <div className="flex gap-2">
                      <Button type="button" aria-pressed={mediaType === "movie"} variant={mediaType === "movie" ? "default" : "outline"} onClick={() => { setMediaType("movie"); setSelectedIdentity(null); setIdentityCandidates([]); void resolveIdentity(identityQuery, "movie") }}>Film</Button>
                      <Button type="button" aria-pressed={mediaType === "tv"} variant={mediaType === "tv" ? "default" : "outline"} onClick={() => { setMediaType("tv"); setSelectedIdentity(null); setIdentityCandidates([]); void resolveIdentity(identityQuery, "tv") }}>Serie</Button>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input placeholder="Cerca il titolo su TMDB" value={identityQuery} onChange={(e) => setIdentityQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void resolveIdentity(identityQuery, mediaType)} />
                    <Button type="button" variant="outline" disabled={!identityQuery.trim() || isSearching} onClick={() => void resolveIdentity(identityQuery, mediaType)}>{isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cerca TMDB"}</Button>
                  </div>
                  {identityCandidates.length > 0 && <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">Seleziona l’identità corretta:</p>
                    {identityCandidates.map((candidate) => <Button key={candidate.tmdbId} type="button" variant={selectedIdentity?.tmdbId === candidate.tmdbId ? "default" : "outline"} className="w-full justify-start" onClick={() => setSelectedIdentity({ ...candidate, kind: mediaType })}>{candidate.title} {candidate.year ? `(${candidate.year})` : ""} · TMDB {candidate.tmdbId}</Button>)}
                  </div>}
                  {selectedIdentity && <p className="text-xs text-muted-foreground">Selezionato: {selectedIdentity.title} · TMDB {selectedIdentity.tmdbId}</p>}
                  <Button type="button" className="w-full" disabled={!selectedIdentity || isSearching} onClick={async () => {
                    setIsSearching(true)
                    try {
                      const response = await fetch("/api/add/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ magnet: pendingAddition.magnet, mode: pendingAddition.mode, mediaType, provider: pendingAddition.provider, name: selectedIdentity.title, identity: selectedIdentity }) })
                      const body = await response.json()
                      if (!response.ok || !body.ok) throw new Error(body.error || "Identity confirmation failed")
                      const destination = body.provider || body.delegatedTo || body.mode || "provider"
                      toast.success(`Identità confermata; inviato a ${destination}`)
                      setPendingAddition(null)
                      setSelectedIdentity(null)
                      setIdentityCandidates([])
                      setIdentityQuery("")
                    } catch (error: any) { toast.error(error.message || "Identity confirmation failed") }
                    finally { setIsSearching(false) }
                  }}>Conferma identità e organizza</Button>
                </div>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Search className="h-5 w-5" />
                  Search & Add
                </CardTitle>
                <CardDescription>Search indexer for content and add the best result automatically</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="search">Search Query</Label>
                  <div className="flex gap-2">
                    <Input
                      id="search"
                      placeholder="Movie Name 2024..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSearchAndAdd()}
                    />
                    <Button onClick={handleSearchAndAdd} disabled={!searchQuery.trim() || isSearching}>
                      {isSearching ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  This will search your configured indexer and automatically add the best result (highest seeders).
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
