// src/components/brand/Logo.tsx
import React from "react";
import logoUrl from "../../assets/brand/fawv_FAvv_all_in_hex_filled.svg";

export default function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return <img src={logoUrl} alt="FAWV logo" className={className} draggable={false} />;
}
