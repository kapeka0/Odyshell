# Odyshell visual guide

The visual language follows the supplied product references: a quiet gray workspace shell, compact
controls, thin borders, small radii, precise typography, and generous white content areas. Odyshell
uses the same system across dashboard, authentication, documentation, and landing without copying
another product's branding or content.

## Character

- Calm, precise, light, and operational.
- Content and live state create hierarchy; decoration does not.
- Dense tables and timelines remain readable through alignment and whitespace.
- Security-sensitive actions are explicit and visually restrained.

## Color

- Page canvas: cool neutral gray.
- Sidebar and main surfaces: near-white with a subtle one-step contrast.
- Borders: low-contrast neutral, always visible.
- Text: near-black primary, medium-gray secondary, quiet metadata.
- Green: connected, active, succeeded.
- Amber: pending approval or attention.
- Red: destructive, denied, revoked, or failed.
- Blue: selected informational state.

Semantic color always appears with text or an icon. Large saturated backgrounds are avoided.

## Typography

- Geist for application, authentication, and docs.
- Manrope for landing display copy.
- Geist Mono for commands, output, IDs, timestamps, and code.
- Application headings are compact and sentence case; landing headlines may be large and tightly
  tracked.

## Geometry and spacing

- Four-point spacing system.
- Controls: 32–36 px high; compact controls: 28 px.
- Buttons and inputs: 6–8 px radius.
- Cards, tables, and large content blocks: 12–16 px radius.
- Borders: 1 px neutral; shadows are rare and shallow.
- Dashboard sidebar: approximately 232 px expanded, with compact icon-first rows and a tonal active
  selection.
- Main content uses a readable max width, large desktop gutters, and full-width operational tables
  only where comparison benefits.

## Components

- Buttons use concise labels, medium weight, and no decorative icons in final form actions.
- Status badges are compact rounded rectangles, not oversized pills.
- Tables use quiet row separators and reserve menus for secondary actions.
- Timeline entries lead with actor/action, then exact command or output in a bordered mono surface.
- Canvas nodes share the table vocabulary: thin border, compact radius, clear state, and one primary
  relationship label.
- Dialogs keep actions bottom-right, Cancel before the primary action.

## Motion

Motion explains topology, continuity, optimistic mutations, and live state. Animate opacity and
transform, keep transitions brief, and honor reduced motion. The Overview canvas may animate active
Agent→Session→Machine edges; inactive topology remains still.

## Landing

The landing follows the structural rhythm of the provided T3 reference: centered oversized hero,
credible product demonstration, alternating feature narratives, a dark technical section, a concrete
Docker self-hosting block, and a final CTA. Odyshell's copy and visual assets remain original and
demonstrate the real Session control plane.

## Accessibility

All interactive elements need accessible names, visible keyboard focus, and a minimum practical
target size. Information cannot depend on color alone. Dialog focus is trapped and restored. Tables,
canvas fallbacks, timeline output, and reduced-motion states remain usable without pointer motion.
