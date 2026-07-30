# Odyshell interface rules

These rules are the source of truth for product interface decisions. They
describe the behavior and qualities users should experience without requiring a
particular component, library or interaction pattern.

## Task and hierarchy

- Give every view one clear purpose and one clearly prioritized next action.
- Show only information and actions useful to the current task.
- Prefer progressive disclosure when secondary detail would compete with the
  primary task.
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
- Keep quick local preferences, including theme selection, in the account menu.
- Reserve user settings for changes persisted to the user's backend profile.
- Keep product branding subordinate to workspace identity and operational work
  inside the authenticated experience.

## Actions and forms

- Use concise, active labels that describe the outcome.
- Establish one primary action per task and give secondary actions quieter
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
- Ensure all essential tasks work with a keyboard and assistive technology.
- Maintain readable contrast in every state and theme.
- Do not rely on color, position, motion or hover alone to communicate meaning.
- Keep task flows usable at narrow widths and high zoom levels.
- Respect reduced-motion and other user preferences.

## Responsive behavior

- Preserve task priority as space decreases; remove decoration before useful
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
- Preserve already available context during navigation and background refreshes.
- Avoid visual resets, duplicate loading states and unexpected layout shifts.
- Keep the last trustworthy state visible when refreshing data, while clearly
  indicating that an update is in progress.
- Fail safely and make unavailable actions visibly unavailable.

## Current product decisions

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
- Pending state stays visually attached to the initiating action. Completion
  feedback announces success or failure once without duplicating progress.
- Transient feedback remains visible above blocking overlays.
- Prefer the shortest label that remains clear in context. Avoid redundant
  qualifiers, repeated explanations and descriptive copy that does not help
  the next action.
- Do not prefix dashboard page titles with an obvious context label such as
  Workspace.
- Activity places the filtered result count above the table and shows the
  workspace plan retention beside it.
- The account menu cycles directly between System, Light and Dark before the
  Settings action. Theme changes do not need success toasts.
- Browser icons follow the active system color scheme.
- Prefer a user's identity-provider photo. When none exists, generate a
  recognizable face from an opaque identifier without displaying initials or
  sending an email address to an external service.
- Give every workspace a stable colored identity mark without displaying
  initials.
- The workspace overview is the operational canvas itself, inspired by
  Railway rather than a dashboard card grid.
- The overview makes the relationship between currently interacting agents,
  active sessions and machines directly inspectable even when the topology is
  crowded.
- The overview updates from live workspace state and shows agent-to-machine
  connections only while activity is actually in progress.
- Online machines use a restrained green live indicator. Offline machines use
  a quiet neutral indicator, and both states include text. Keep the active dot
  solid; animate only a restrained halo around it with the ping motion.
- Operational collections support search, relevant filters, sorting and
  pagination. Row details and secondary actions stay behind a consistent
  actions menu.
- Important table identifiers are copyable from the value itself. Reveal the
  copy affordance with a restrained horizontal hover or focus animation.
- Destructive row actions remain secondary, require confirmation and never
  compete with the view's primary creation action.
- Collapsing workspace navigation preserves every icon, animates smoothly and
  does not introduce an unnecessary scrollbar.
- Platform-wide degraded states use a compact warning bar above navigation,
  not a floating toast.
- Personal settings and workspace settings have separate destinations.
  Workspace security settings are visible to members and editable only by
  administrators.
- Control Events remain privacy-minimal in the MVP. Do not present unavailable
  logging policies as editable choices.
