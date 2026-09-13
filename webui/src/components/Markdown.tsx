// Report bodies are markdown written by a model from Discord content; raw HTML
// in them would be a way for a stranger to run script in this page, so angle
// brackets are neutralised before parsing.

import { useMemo } from "react";
import { marked } from "marked";

export function Markdown({ source }: { source: string }) {
  const html = useMemo(
    () => marked.parse(source.replace(/</g, "&lt;"), { async: false, gfm: true, breaks: false }) as string,
    [source],
  );
  return (
    <div
      className="report-md"
      dangerouslySetInnerHTML={{
        __html: html.replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener noreferrer" href="$1"'),
      }}
    />
  );
}

/** Section headings of a report, in order — the outline shown above the body. */
export function outlineOf(source: string): { id: string; text: string; level: number }[] {
  const out: { id: string; text: string; level: number }[] = [];
  const lines = source.split("\n");
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!m) return;
    out.push({ id: `s${i}`, text: m[2].replace(/[*_`]/g, ""), level: m[1].length });
  });
  return out;
}
