"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { repoUrl } from "@/lib/env";
import { useNetwork } from "@/lib/network";
import { GitHubIcon } from "./Icons";
import { LogoMark } from "./Logo";

const links = [
  { href: "/#demo", label: "Live demo" },
  { href: "/#how", label: "How it works" },
  { href: "/#feed", label: "On-chain" },
  { href: "/#build", label: "Developers" },
  { href: "/console", label: "Console" },
];

export function Header() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const { isConnected, chainId } = useAccount();
  const { net, select, switchingTo, switchError } = useNetwork();
  const onConsole = pathname.startsWith("/console");
  const wrongNetwork = onConsole && isConnected && chainId !== net.chain.id && !switchingTo;

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <>
      <header className={`topbar${scrolled || onConsole ? " scrolled" : ""}`}>
        <div className="shell">
          <Link href="/" className="brand" aria-label="SpendLeash home">
            <LogoMark />
            <span className="brand-name">SpendLeash</span>
          </Link>
          <nav className="nav" aria-label="Main">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.href === "/console" && onConsole ? "page" : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="topbar-end">
            <a className="icon-btn" href={repoUrl} target="_blank" rel="noreferrer" title="Source on GitHub" aria-label="Source on GitHub">
              <GitHubIcon />
            </a>
            {onConsole ? (
              <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
            ) : (
              <Link href="/console" className="btn small">
                Open console
              </Link>
            )}
          </div>
        </div>
      </header>
      {onConsole && switchingTo && (
        <div className="banner info" role="status">
          <div className="shell">
            <span>Confirm the switch to {switchingTo.chain.name} in your wallet.</span>
          </div>
        </div>
      )}
      {onConsole && switchError && !switchingTo && (
        <div className="banner" role="alert">
          <div className="shell">
            <span>{switchError}</span>
          </div>
        </div>
      )}
      {wrongNetwork && (
        <div className="banner" role="alert">
          <div className="shell">
            <span>
              Your wallet is on another network. SpendLeash runs on {net.chain.name} ({net.chain.id}).
            </span>
            <button type="button" className="btn small" onClick={() => select(net.key)}>
              Switch network
            </button>
          </div>
        </div>
      )}
    </>
  );
}
