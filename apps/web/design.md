# Design — Odyshell

A shared visual system for the marketing site and authenticated control plane.
It is intentionally quiet: the product is security infrastructure, so clarity,
state and hierarchy carry the interface.

## Genre

Modern-minimal.

## Macrostructure family

- Marketing: product-led landing with a compact hero, live interface specimen,
  trust boundaries and one direct CTA.
- App: workbench with a persistent collapsible sidebar, thin top bar and
  content-first operational panels.
- Authentication: centered task surface with a short product explanation.

## Theme

Neutral Vercel palette from the tweakcn Vercel preset. Pure neutral paper and
ink, grayscale surfaces, semantic status colors used only for state.

- Light paper: `oklch(0.99 0 0)`
- Light ink: `oklch(0 0 0)`
- Dark paper: `oklch(0 0 0)`
- Dark ink: `oklch(1 0 0)`
- Focus: current foreground with a visible offset ring

## Typography

- Display and body: Geist, roman, weight 400–650
- Data and commands: Geist Mono, weight 400–550
- Display tracking: `-0.04em` only for the landing headline
- App headings stay compact and sentence case

## Spacing

A 4-point named scale defined in `tokens.css`. Pages and components use the
shared tokens or Tailwind spacing derived from the same base.

## Motion

- Motion is limited to the landing entrance and live route indicator.
- Only opacity and transform animate.
- Reduced motion collapses to opacity-only transitions of at most 150ms.

## Microinteractions stance

- Silent success over celebratory feedback
- Destructive actions require explicit confirmation
- Focus is immediate and always visible
- Hover tooltips appear only for collapsed sidebar navigation
- Landing navigation is N9 edge-aligned minimal; authenticated navigation is a
  shadcn workbench sidebar with an N13 command palette
- The footer is Ft5 statement-led rather than a sitemap

## CTA voice

- Primary: black/white filled control, concise active verb
- Secondary: neutral outline, no decorative icon unless it clarifies direction

## Per-page allowances

- Marketing may use the real product preview as its only enrichment.
- App pages use no decorative enrichment.
- Authentication pages stay flush and task-focused.

## What pages must share

- Odyshell wordmark and square mark
- Neutral theme and semantic state colors
- Geist and Geist Mono
- Radius, border and focus treatment
- Sentence-case navigation and actions

## What pages may differ on

- Marketing can use wider type and more whitespace.
- App surfaces can be denser and operational.
- Authentication can collapse to one narrow task column.
