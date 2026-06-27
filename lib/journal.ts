const KNOWN_IEEE_JOURNALS: Array<{
  match: RegExp;
  slug: string;
  canonicalName: string;
}> = [
  {
    match: /systems|man,\s*and\s*cybernetics/i,
    slug: "systems",
    canonicalName: "IEEE Transactions on Systems, Man, and Cybernetics: Systems",
  },
  {
    match: /internet\s+of\s+things|iot/i,
    slug: "iot",
    canonicalName: "IEEE Internet of Things Journal",
  },
];

function slugFromExplicitUrl(explicitUrl?: string) {
  if (!explicitUrl?.trim()) return null;

  try {
    const url = new URL(explicitUrl.trim());
    const pathSlug = url.pathname.split("/").filter(Boolean).at(-1);
    return pathSlug || url.hostname.replace(/^mc\./i, "").split(".")[0] || null;
  } catch {
    return null;
  }
}

export function resolveJournal(inputName: string, explicitUrl?: string) {
  const journalName = inputName.trim();
  const known = KNOWN_IEEE_JOURNALS.find((item) => item.match.test(journalName));
  const explicitSlug = slugFromExplicitUrl(explicitUrl);
  const slug =
    explicitSlug ??
    known?.slug ??
    journalName
      .toLowerCase()
      .replace(/^ieee\s+/i, "")
      .replace(/transactions?\s+on\s+/i, "")
      .replace(/journal\s+of\s+/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);

  return {
    journalName: known?.canonicalName ?? journalName,
    slug,
    manuscriptUrl: explicitUrl?.trim() || `https://mc.manuscriptcentral.com/${slug}`,
  };
}

export function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  const visible = name.length <= 2 ? name[0] ?? "" : `${name.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}
