# Odyshell frontend rules

These rules are the source of truth for product UI decisions. Read them before
changing the web app and update them whenever a new UI direction is agreed.

## Product surfaces

- Keep operational screens clean, quiet and content-first. Show only controls
  that are useful for the current task.
- Every dashboard navigation item opens a distinct route.
- GitHub and other public-site links belong on the landing page, not in the
  authenticated dashboard.
- The CLI activation flow lives outside the dashboard and never renders its
  sidebar. It ends on a dedicated success or error route.

## Navigation

- Compose the authenticated navigation from the official shadcn `sidebar-07`
  block and sidebar primitives.
- Do not show the Odyshell logo or wordmark inside the app sidebar.
- Keep the sidebar limited to workspace selection, product routes and the user
  menu.
- Put theme selection only in user settings.

## Components and actions

- Prefer official shadcn components and blocks before creating custom UI
  primitives.
- Put creation and configuration forms in a shadcn `Dialog`, opened by one
  concise primary action such as **Add machine**.
- Keep destructive actions behind an explicit shadcn confirmation dialog.
- Every asynchronous action must disable repeat submission, show a spinner
  while pending and report its result with a shadcn toast.
- Use Clerk for identity, sessions and organization data through hooks and
  server APIs. Do not render Clerk's visual components.

## Visual language

- Use the neutral Vercel palette, Geist typography and restrained borders.
- Favor whitespace and clear hierarchy over decorative cards or illustrations
  in the dashboard.
- Keep labels and actions concise and sentence case.
- Use status color only when it communicates real state.
- Animations must be subtle, use opacity or transform and respect reduced
  motion preferences.

## Performance and accessibility

- Route transitions must not repeat workspace or server requests that the
  dashboard layout has already completed.
- Use semantic forms, explicit button types, visible focus states and accessible
  labels.
- Dialogs must remain usable on small screens and with keyboard navigation.
- Loading, empty, success and failure states must always be visible and
  understandable.
