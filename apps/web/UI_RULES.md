# Odyshell interface rules

These rules are the source of truth for product interface decisions. They
describe the behavior and qualities users should experience without requiring a
particular component, library or interaction pattern.

## Session and hierarchy

- Give every view one clear purpose and one clearly prioritized next action.
- Show only information and actions useful to the current session.
- Prefer progressive disclosure when secondary detail would compete with the
  primary session.
- Keep operational screens quiet, content-first and free of decorative
  enrichment.
- Preserve the user's context when configuration or creation work does not
  require a separate journey.

## Information architecture

- Give every authenticated destination a distinct, addressable location.
- Make the user's current location and available destinations clear.
- Keep workspace selection, product navigation and account management easy to
  distinguish.
- Keep public and promotional destinations outside the authenticated workspace.
- Keep CLI activation outside the authenticated workspace and end it in an
  unambiguous success or failure state.
- After CLI activation succeeds, keep terminal completion primary and present
  unreleased follow-up commands as clearly unavailable. Never place activation
  codes, tokens or session data in those commands.
- Keep Agent registration focused. Session exceptions are supervised in the
  authenticated Sessions view with the exact Agent, Machine, operating-system user,
  purpose, and expiry visible before a decision.
- Keep quick local preferences, including theme selection, in the account menu.
- Reserve user settings for changes persisted to the user's backend profile.
- Keep product branding subordinate to workspace identity and operational work
  inside the authenticated experience.

## Actions and forms

- Use concise, active labels that describe the outcome.
- Establish one primary action per session and give secondary actions quieter
  emphasis.
- Make forms understandable in reading order, with persistent labels, useful
  guidance and errors connected to the relevant input.
- Prevent repeat submission while an action is pending.
- Communicate progress and the eventual result of every asynchronous action.
- Require explicit, unambiguous confirmation before destructive or irreversible
  actions.
- Preserve entered data after recoverable failures whenever it is safe to do so.

## System state and feedback

- Make loading, empty, success, failure and unavailable states visible and
  understandable.
- Distinguish between “no data,” “not yet loaded” and “failed to load.”
- Keep status close to the object or action it describes.
- Use semantic color only when it conveys real state, and pair it with text or
  another non-color signal.
- Make recovery paths clear when the user can resolve a failure.
- Do not expose secrets, credentials or sensitive implementation details in
  interface feedback.

## Navigation and continuity

- Keep navigation placement and ordering predictable across authenticated views.
- Preserve workspace and account context while moving between related
  destinations.
- Avoid repeating global context inside each page when the surrounding
  experience already communicates it.
- Ensure narrow screens retain access to the same essential destinations and
  actions without obscuring page content.

## Language

- Use plain, concise and sentence-case language.
- Begin every user-facing label with a capital letter.
- Prefer specific domain terms over generic labels.
- Explain consequences before asking for confirmation.
- Write errors in terms of what happened and what the user can do next.
- Avoid promotional language in operational and security-sensitive flows.

## Accessibility

- Use semantic structure and controls that match their purpose.
- Keep focus visible and move it predictably after navigation, submission and
  state changes.
- Provide accessible names for every interactive element.
- Ensure all essential sessions work with a keyboard and assistive technology.
- Maintain readable contrast in every state and theme.
- Do not rely on color, position, motion or hover alone to communicate meaning.
- Keep session flows usable at narrow widths and high zoom levels.
- Respect reduced-motion and other user preferences.

## Responsive behavior

- Preserve session priority as space decreases; remove decoration before useful
  information or actions.
- Reflow content in a logical reading order rather than shrinking it beyond
  legibility.
- Keep touch targets comfortably operable.
- Prevent essential actions, feedback and validation from being hidden by
  overflow or transient interface elements.

## Performance and resilience

- Show useful structure promptly and avoid blocking unrelated parts of a view.
- Every route owns a loading skeleton that mirrors its final structure. A
  canvas skeleton belongs only to the overview; table, form and settings
  routes use their corresponding shapes.
- Every visual change also reviews its route-level skeleton. When visible
  layout, spacing or hierarchy changes, update the skeleton in the same change.
- Preserve already available context during navigation and background refreshes.
- Avoid visual resets, duplicate loading states and unexpected layout shifts.
- Keep the last trustworthy state visible when refreshing data, while clearly
  indicating that an update is in progress.
- Every safe, reversible frontend mutation uses optimistic UI: reflect the
  intended result immediately, reconcile it in the background and restore the
  previous state with clear feedback if the request fails.
- Fail safely and make unavailable actions visibly unavailable.

## Current product decisions

- The public landing leads with temporary, attributable shell authority. Standard Agents require a
  Human decision; Operator Agents bypass it and are presented with an SSH-equivalent warning.
- The public landing uses restrained neutral surfaces, medium-weight typography, compact radii and
  generous page gutters. Its signature product visual is a real Session and Command crossing Server
  and Local Policy, not decorative illustration.
- Present Odyshell as free, self-hosted, and unlimited. The public site sends users to the Docker
  distribution and documentation; authentication and the dashboard belong only to each installation.
  Public copy covers Windows, Linux, macOS, Session, Command, MCP, HTTP, and self-hosted behavior
  available in the current release.
- Machine enrollment gets a dedicated, uncluttered view. The one-time command
  must remain fully visible and must not be clipped by an overlay.
- Short creation flows preserve context and remain comfortable at narrow
  widths.
- Creation forms use a dedicated route when their fields cannot fit comfortably
  in a small dialog.
- Dialog and form actions stay at the bottom-right. Place Cancel before the
  primary action.
- Final form and dialog actions use no decorative icons and prefer one-word
  labels such as Add, Create or Cancel. Entry-point actions such as an Add
  button that opens a dialog or creation route may use a leading icon.
- Select triggers show the user-facing label for the current value, never its
  internal value.
- Default Input, Select and Button controls share one height and internal
  spacing scale. Compact variants use the same smaller scale.
- Text areas follow the surrounding layout and never expose browser resize
  handles.
- Pending state stays visually attached to the initiating action. Completion
  feedback announces success or failure once without duplicating progress.
- Identity-provider actions use the provider's recognizable mark beside a clear
  text label while preserving the form's primary hierarchy.
- Transient feedback remains visible above blocking overlays.
- Prefer the shortest label that remains clear in context. Avoid redundant
  qualifiers, repeated explanations and descriptive copy that does not help
  the next action.
- Do not prefix dashboard page titles with an obvious context label such as
  Workspace.
- Tables place the filtered result count above the table, show optional context
  on the right and center pagination below. Activity uses that context for the
  configured audit retention. Table skeletons preserve this same order.
- Collection creation actions live in the table toolbar, never in the page
  header. Search and filters form the left group; the concise Add or New action
  forms the right group. Table skeletons preserve both groups.
- Keep button labels stable when an action is unavailable. Explain a limit or
  blocking condition in concise red text directly below the disabled action,
  never by replacing the action label with the error.
- The account menu cycles directly between System, Light and Dark before the
  Settings action, with comfortable inner padding between actions. Theme
  changes do not need success toasts.
- Browser icons follow the active system color scheme.
- Browser tab titles use a vertical bar to separate the page name from the
  product name or tagline.
- The selected sidebar link is one restrained tonal step stronger than hover,
  with a subtle inset border rather than a high-contrast block.
- Prefer a user's identity-provider photo. When none exists, generate a
  recognizable face from an opaque identifier without displaying initials or
  sending an email address to an external service.
- Recognized Agent providers use their bundled local brand mark wherever Agent
  identity is shown. Unknown or custom Agents use the neutral Agent fallback.
- Give every Organization a stable colored identity mark without displaying
  initials.
- Online machines use a restrained green live indicator. Offline machines use
  a quiet neutral indicator, and both states include text. Keep the active dot
  solid; animate only a restrained halo around it with the ping motion.
- Operational collections support search, relevant filters, sorting and
  pagination. Row details and secondary actions stay behind a consistent
  actions menu.
- Session requests appear in the Sessions view immediately. Pending exceptions are
  visually separated from recent work, and the same durable Session is updated
  after approval instead of duplicated.
- Session purposes remain concise and truncate when necessary. Human supervisors
  use their recognizable name and profile image; internal identity IDs are
  never presented as names.
- Activity actors follow the same identity rule: show a member's profile image
  and name when available, and never present an internal user ID as their name.
- Session views show expiry in the viewer's timezone.
- Important table identifiers are copyable from the value itself. Reveal the
  copy affordance with a restrained horizontal hover or focus animation.
- Status tags use restrained semantic color to make operational state scannable:
  green for healthy or completed states, blue for informational or proposed
  states, amber for paused or attention states, red for denied or revoked
  states and neutral styling for inactive terminal states. Always pair color
  with a text label.
- Copyable values preserve readable text contrast in every interaction state,
  including when the surrounding surface inverts foreground and background.
- Generated commands use a quiet secondary surface with a thin border. Avoid
  full foreground/background inversion for large code blocks. Keep their copy
  control persistently visible in the top-right corner without animating its
  position or visibility.
- Destructive row actions remain secondary, require confirmation and never
  compete with the view's primary creation action.
- Machine rows show a concise, truncated description beneath the name when one
  exists. Machine editing may change Server metadata and reduce effective
  capabilities, but it can never grant beyond the Client Local Policy.
- Machine details expose whether the bound operating-system user can use sudo.
  Session supervision warns clearly whenever granted shell authority can reach
  root privileges.
- Machine rows omit internal IDs. Session audit identifiers remain copyable where
  they are necessary to correlate Agent and API work.
- Agent rows show when the identity was created in the viewer's local timezone.
- Users can permanently delete any Agent from its actions. Deletion closes
  active Sessions, requires confirmation, and retains audit evidence according to
  the Organization retention policy.
- Collapsing Organization navigation preserves every icon, animates smoothly and
  does not introduce an unnecessary scrollbar.
- The dashboard navbar keeps only the sidebar toggle on its left edge. The
  sidebar retains a visible right border using the same token as the navbar.
- Keep Organization administration in a separate group directly after primary
  navigation inside `SidebarContent`, ready for Settings, Members and future
  management routes.
- Platform-wide degraded states use a compact warning bar above navigation,
  not a floating toast.
- Organization notifications use a compact Sheet beside Quick actions. Show a
  restrained red indicator only while unread items exist, and let members mark
  one item as read or unread and all items as read. Opening the Sheet alone does
  not change read state. Each item has a concise title and description; clicking
  it marks it read and opens the relevant destination.
- Notification relative time never counts seconds. Use Just now for the first
  minute, then minute-or-larger units, and expose the exact timestamp in the
  user's timezone on hover. Retain notifications for 30 days.
- Direct control notifications go to the member responsible for the
  initiating action. Keep notification copy privacy-minimal: never include
  commands, paths, Command output, credentials, or Session purpose.
- Sessions use a concise required title and optional purpose. Tables and canvas
  nodes lead with the title and show the single target Machine and bound
  operating-system user.
- Agents create Sessions and Commands through HTTP or remote MCP. The dashboard
  observes, approves, denies, and audits; it does not provide a parallel manual
  execution flow.
- Session and Command audit is chronological and attributable. Exact command,
  working directory, timeout, status, and exit code may be shown to authorized
  members; bounded stdout and stderr are retained in the Session timeline according to policy.
- Personal settings and Organization settings have separate destinations.
  Organization security settings are visible to members and editable only by
  administrators.
- Settings pages group related fields into named sections. Inside each contained
  surface, use responsive horizontal rows with the label and concise guidance on
  the left, the control on the right, quiet spacing instead of inner separators,
  and actions at the bottom-right. Every field includes brief helper text and
  security-sensitive choices link to public documentation. Keep each Card on one
  background and use the default shadcn treatment for Alerts and Dialogs. Their
  skeletons preserve the same section and row structure.
- Session audit always stores the exact command and security-relevant metadata.
  Credentials, enrollment tokens, OAuth tokens, and Machine private keys never belong in durable
  audit or user-facing error feedback. Bounded stdout/stderr belong only to the retained timeline.
- Keep public documentation outside the authenticated workspace and make it usable
  without an authenticated product session.
- Documentation starts with the Docker self-hosting workflow, uses progressive disclosure and
  describes only behavior available in the current release.
- Documentation must serve people and agents from one reviewed source. Keep
  Markdown pages and LLM indexes discoverable without adding provider-specific
  actions.
- Public installation uses the canonical npm command for the cross-platform CLI.
- The landing introduces documentation once, after the product workflow, with one
  clear action.
