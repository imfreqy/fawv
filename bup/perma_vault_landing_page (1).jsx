import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";

export default function PermaVaultLanding() {
  return (
    <div className="min-h-screen bg-gray-950 text-white px-6 py-12">
      <header className="text-center space-y-6 mb-12">
        <h1 className="text-5xl font-bold">Your Digital Legacy. Endowed in Perpetuity.</h1>
        <p className="text-xl text-gray-300">Tokenize your files. Preserve them forever. Reclaimable, inheritable, immutable.</p>
        <div className="flex justify-center gap-4">
          <Button size="lg">Get Started</Button>
          <Button variant="outline" size="lg">Watch Demo</Button>
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
        {[
          { title: "Permanence", desc: "Archive and tokenize files in your personal vault. Pay a small annual fee to maintain control." },
          { title: "Heirloom", desc: "Endow key assets with Filecoin backup and lifetime permanence." },
          { title: "Marketplace", desc: "Unclaimed assets enter a public marketplace with buy-back or acquisition paths." },
        ].map((tier, index) => (
          <Card key={index} className="bg-gray-900 rounded-2xl shadow-xl">
            <CardContent className="p-6">
              <h3 className="text-2xl font-semibold mb-2">{tier.title}</h3>
              <p className="text-gray-300">{tier.desc}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">Why PermaVault</h2>
        <p className="text-gray-400 mb-6">Built for creators, families, and data custodians.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            "📦 Tokenized ownership",
            "🔐 Endowment-based permanence",
            "🪙 Smart contract asset valuation",
            "☁️ Google Drive & Dropbox Integration",
            "🧬 Designed for digital legacy",
            "🧠 AI Dataset & Archive-Ready"
          ].map((feature, idx) => (
            <div key={idx} className="bg-gray-800 p-4 rounded-xl text-lg">{feature}</div>
          ))}
        </div>
      </section>

      <section className="mb-20">
        <h2 className="text-3xl font-bold mb-4 text-center">Pricing Plans</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            {
              title: "Permanence",
              price: "$5/mo",
              features: ["1TB Vault", "Tokenized Access", "Annual Renewal"]
            },
            {
              title: "Heirloom",
              price: "$50 one-time",
              features: ["Filecoin Backup", "Legacy Security", "No Expiry"]
            },
            {
              title: "Marketplace Buy-Back",
              price: "Varies",
              features: ["Auction Model", "Speculator Access", "Smart Contract Enforcement"]
            }
          ].map((plan, i) => (
            <Card key={i} className="bg-gray-900">
              <CardContent className="p-6 space-y-3">
                <h3 className="text-2xl font-bold">{plan.title}</h3>
                <p className="text-xl text-green-400">{plan.price}</p>
                <ul className="text-gray-300 space-y-1">
                  {plan.features.map((f, j) => <li key={j}>• {f}</li>)}
                </ul>
                <Button variant="secondary">Choose Plan</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <footer className="text-center text-sm text-gray-500 border-t border-gray-700 pt-6">
        &copy; {new Date().getFullYear()} PermaVault. All rights reserved.
      </footer>
    </div>
  );
}
