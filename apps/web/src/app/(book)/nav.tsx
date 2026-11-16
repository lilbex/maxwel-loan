'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Nav({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="spine-nav" aria-label="Main">
      {links.map(({ href, label }) => {
        const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
