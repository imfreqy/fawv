import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ShieldCheck, Archive, Wallet, Search } from 'lucide-react'

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-white px-6 py-12">
      <header className="text-center space-y-4 mb-12">
        <h1 className="text-5xl font-extrabold tracking-tight">PermaVault</h1>
        <p className="text-lg text-gray-300 max-w-2xl mx-auto">
          Tokenize your files. Preserve them forever. Reclaimable, inheritable, immutable.
        </p>
        <div className="flex justify-center gap-3">
          <Button size="lg"><ShieldCheck className="mr-2 h-5 w-5"/>Get Started</Button>
          <Button variant="outline" size="lg"><Archive className="mr-2 h-5 w-5"/>Watch Demo</Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto space-y-8">
        <Tabs defaultValue="upload" className="space-y-4">
          <TabsList>
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="market">Marketplace</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
          </TabsList>

          <TabsContent value="upload">
            <Card>
              <CardHeader>
                <CardTitle>Upload Archive</CardTitle>
                <CardDescription>Add your files and create a tokenized archive.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-3 items-center">
                  <Input placeholder="Search or paste Google Drive link…" />
                  <Button variant="secondary"><Search className="mr-2 h-4 w-4"/>Browse</Button>
                </div>
                <div className="flex gap-3">
                  <Button>Choose Files</Button>
                  <Button variant="outline">Create Archive Block</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="market">
            <Card>
              <CardHeader>
                <CardTitle>Marketplace</CardTitle>
                <CardDescription>Discover unclaimed or tokenized archives.</CardDescription>
              </CardHeader>
              <CardContent className="grid md:grid-cols-3 gap-4">
                {['FamilyPhotos_1998_2005', 'HUD_Settlement_2001', 'ArtPortfolio_v1'].map((name) => (
                  <div key={name} className="rounded-2xl border border-white/10 bg-gray-900 p-4">
                    <div className="font-semibold mb-1">{name}</div>
                    <div className="text-sm text-gray-400">Tokenized • Heirloom-ready</div>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm">View</Button>
                      <Button variant="outline" size="sm">Buy</Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="account">
            <Card>
              <CardHeader>
                <CardTitle>Account</CardTitle>
                <CardDescription>Manage your keys, plans, and endowments.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <div className="text-sm text-gray-400 mb-1">Email</div>
                    <Input placeholder="you@example.com" />
                  </div>
                  <div>
                    <div className="text-sm text-gray-400 mb-1">Wallet (optional)</div>
                    <Input placeholder="0x..." />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button>Save</Button>
                  <Button variant="outline">Connect Wallet</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <footer className="text-center text-sm text-gray-500 border-t border-white/10 mt-12 pt-6">
        &copy; {new Date().getFullYear()} PermaVault. All rights reserved.
      </footer>
    </div>
  )
}
