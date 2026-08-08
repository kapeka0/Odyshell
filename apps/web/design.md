# Design — Odyshell

This document defines the visual foundation shared by Odyshell's public,
authenticated and task-focused interfaces. It describes the intended qualities
of the experience without prescribing a particular component or implementation.

## Design character

Odyshell is modern, minimal and quiet. It is security infrastructure, so the
interface earns trust through clarity, restraint and legible system state rather
than decoration.

Every surface should feel:

- Calm, precise and purposeful
- Dense only where operational work benefits from density
- Consistent without making unlike tasks look identical
- Confident without becoming promotional or theatrical

## Visual hierarchy

- Let content, state and task priority determine the hierarchy.
- Give each view one unmistakable primary purpose.
- Use whitespace to separate concepts before introducing additional boundaries.
- Keep headings compact, sentence case and proportional to their importance.
- Reserve the strongest contrast for primary content and actions.
- Keep supporting information visibly subordinate without making it illegible.

## Color

Use the neutral Odyshell palette defined in `tokens.css`.

- Light paper: `oklch(0.99 0 0)`
- Light ink: `oklch(0 0 0)`
- Dark paper: `oklch(0 0 0)`
- Dark ink: `oklch(1 0 0)`
- Focus: the current foreground with a visible offset

Neutral paper, ink and grayscale surfaces form the default visual language.
Semantic colors communicate meaningful status only; they are not decoration.
Color must never be the sole carrier of meaning.

## Typography

- Use Manrope for public landing display and body copy at weights 400–600.
- Use Geist for authenticated, authentication and documentation display and body copy at weights
  400–650.
- Use Geist Mono for data, identifiers and commands at weights 400–550.
- Keep body copy direct, compact and easy to scan.
- Use tight display tracking only for the public landing headline.
- Keep application headings restrained and sentence case.
- Preserve tabular clarity where values need to be compared.

## Spacing, geometry and density

- Use the shared four-point spacing scale defined in `tokens.css`.
- Build rhythm from named spacing values rather than isolated measurements.
- Keep radii and border treatments consistent across surfaces.
- Prefer alignment and spacing over nested containers.
- Public surfaces may use wider measures and more whitespace.
- Operational surfaces may be denser, but never cramped.
- Task-focused surfaces should remove anything unrelated to task completion.

## Motion

- Use motion only to explain entry, continuity or a meaningful state change.
- Animate opacity and transform rather than layout-affecting properties.
- Keep feedback immediate and transitions brief.
- Respect reduced-motion preferences.
- Under reduced motion, use opacity-only transitions no longer than 150ms.
- Avoid celebratory, ambient or decorative animation in operational flows.

## Interaction tone

- Prefer silent, legible success over celebratory feedback.
- Make focus immediate, visible and consistent.
- Keep labels and actions concise, active and sentence case.
- Use filled high-contrast treatment for the primary action.
- Use quieter treatment for secondary actions.
- Add visual cues only when they clarify meaning or direction.

## Surface character

### Public

Public pages may use broader typography and more whitespace. They should explain
the product through a compact value proposition, a credible product example,
clear trust boundaries and one direct next step. The real product is the primary
source of visual interest. Public geometry uses compact radii and a wide layout with deliberate
24-pixel gutters at desktop scale; avoid pill-shaped page containers and oversized cards.

### Authenticated

Authenticated pages are operational workspaces. They should prioritize current
state, available work and clear navigation while avoiding promotional content
and decorative enrichment. Branding remains subordinate to the user's workspace
and task.

### Authentication and activation

Authentication and activation are narrow, task-focused journeys. They should
provide enough product context to establish trust, then remove distractions and
make progress, success and failure unmistakable.

## Shared identity

All surfaces share:

- The neutral palette and semantic status colors
- Geist and Geist Mono
- The spacing scale, radii, borders and focus treatment
- Concise, sentence-case language
- Restrained motion and a clear hierarchy

Surface differences should come from task, density and context—not from
unrelated visual systems.
