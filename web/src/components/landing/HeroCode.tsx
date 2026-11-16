"use client";

import { useEffect, useState } from "react";

const SOURCE = `function _check(PaymentIntent calldata intent, bytes calldata sig)
    internal view returns (bytes4)
{
    Session storage s = _sessions[intent.sessionId];
    if (s.revoked) return SessionIsRevoked.selector;
    if (block.timestamp > s.validUntil) return SessionExpired.selector;
    if (!isMerchantAllowed[intent.sessionId][intent.merchant])
        return MerchantNotAllowed.selector;
    if (intent.amount > s.perPaymentCap) return PerPaymentCapExceeded.selector;
    if (spentToday + intent.amount > s.dailyCap) return DailyCapExceeded.selector;
    if (!SignatureChecker.isValidSignatureNow(s.agent, hashIntent(intent), sig))
        return BadSignature.selector;
    return bytes4(0);
}`;

/** Faint contract source typing itself behind the hero, like a terminal left running. */
export function HeroCode() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setN(SOURCE.length);
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i = i >= SOURCE.length + 120 ? 0 : i + 2;
      setN(Math.min(i, SOURCE.length));
    }, 28);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="hero-code" aria-hidden="true">
      {SOURCE.slice(0, n)}
      <span className="cursor" />
    </div>
  );
}
