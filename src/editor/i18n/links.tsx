// A link to another site inside a translated sentence. Kept here, apart from components/, which import the texts.
import type { ReactNode } from 'react';

export function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="focus-ring underline underline-offset-2">
      {children}
    </a>
  );
}
