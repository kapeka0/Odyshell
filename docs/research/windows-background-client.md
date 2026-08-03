# Persistent per-user Client execution on Windows

Verified: 2026-08-03.

## Decision

Keep Task Scheduler as the per-user lifecycle manager, but replace the
PowerShell/console launch chain with a small, signed Windows-subsystem launcher.
Register the task at user logon with `InteractiveToken` and `RunLevel=Limited`.
The launcher must start Node with `CREATE_NO_WINDOW`, remain alive while the
Client runs, return the Client's exit code, and own the complete child process
tree in a kill-on-close job object.

This is the smallest long-term design that satisfies the current product
boundary:

- the Client operates as the signed-in user and must access that user's
  workspace;
- it needs outbound network access but opens no inbound listener;
- it should require neither an administrator nor a stored Windows password;
- closing an interactive terminal must not affect it;
- the operating system must be able to report, stop, and restart one Client per
  Profile.

A conventional Windows Service is the right upgrade only if Odyshell later
requires boot-to-shutdown availability, including before logon and after
logout. That would be a different product boundary and would require an
elevated installer plus an explicitly provisioned least-privilege service
identity.

## Why the visible terminal is a lifecycle bug

`TaskSettings.Hidden` does **not** hide a process window. Microsoft defines it
only as hiding the task from the Task Scheduler UI.[^task-hidden] Likewise,
PowerShell's `-WindowStyle Hidden` sets a window style; it does not change the
executable subsystem or create a console process with `CREATE_NO_WINDOW`.[^ps-window-style]

Windows gives a `/SUBSYSTEM:CONSOLE` executable a console, whereas a
`/SUBSYSTEM:WINDOWS` executable does not require one.[^subsystem] A console
child inherits its parent's console by default unless its creator selects a
different process-creation mode.[^creation-flags] If the user closes that
console, Windows sends `CTRL_CLOSE_EVENT` to every attached process and then
terminates them.[^ctrl-close] That exactly explains the observed combination:
a terminal is visible, and closing it makes the machine go offline.

The task's visibility, the launcher's window style, and the Client's console
attachment are therefore three separate properties. Setting only the first or
second cannot establish terminal-independent execution.

## Options compared

| Mechanism | User workspace and outbound identity | No visible console | Persistence and supervision | Elevation / credentials | Fit |
| --- | --- | --- | --- | --- | --- |
| Windows Service, built-in account | Wrong profile; `NetworkService` presents the machine identity remotely and `LocalSystem` is highly privileged | Yes, in Session 0 | Native SCM start, stop, recovery, and boot lifecycle | Admin install; no user password for built-in accounts | Reject for the current per-user Client |
| Windows Service, user account | Can be granted the workspace and network access | Yes, in Session 0 | Native SCM lifecycle | Admin install, `Log on as a service`, account/password maintenance | Technically viable, operationally too heavy |
| Per-user service template | Runs in each signed-in user's security context and is removed at logout | Yes | Native SCM lifecycle | Machine-wide template in `HKLM`; elevated installation and native service integration | Consider only with a future signed installer |
| Task, `Password` logon | User account and network-capable credentials | Non-interactive desktop, though the child must still be launched correctly | Task restart/status controls | Password required at registration; batch-logon right and password lifecycle | Reject for passwordless CLI installation |
| Task, `S4U` logon | Microsoft explicitly denies network and EFS access | Non-interactive desktop | Task restart/status controls | No password, but batch-logon right | Reject: no outbound network access |
| Task, `InteractiveToken` | Existing signed-in user's token, workspace, profile, and network context | Only if the executable is genuinely console-less | Task restart/status controls while the user is logged in | No password and no admin required for the user's own limited task | Best lifecycle principal for current scope |
| Startup folder / `HKCU\\...\\Run` | Signed-in user's context | Yes for a GUI/no-console executable | Starts at logon but has no native restart or status model | No admin or password | Too weak as a Client supervisor |
| PowerShell hidden launcher | Signed-in user's context | Hides a window; does not guarantee that no console exists | Scheduler sees the shell wrapper; process-tree stop behavior is indirect | No admin, but adds shell parsing and a mutable script | Not a robust long-term boundary |
| Windows-subsystem launcher + per-user task | Signed-in user's context | Yes; launcher has no console and uses `CREATE_NO_WINDOW` for Node | Scheduler tracks launcher; launcher tracks Node and its job | No admin or password | Recommended |

### Windows Services

Services are appropriate for long-running daemons that must be available from
boot until shutdown.[^about-services] They execute in Session 0, which is
isolated from interactive user sessions.[^session-zero] Creating one requires
SCM rights that Microsoft grants to administrators by default.[^service-access]

Every service executes under a specific account and access token. The Service
Control Manager loads that account's profile, but an ordinary user-account
service also introduces password expiry and synchronization failure modes.[^service-users]
Microsoft recommends selecting the least-privileged service identity and using
`LocalSystem` only when the service genuinely needs administrative operating
system access.[^service-logon]

Odyshell has no privileged driver, inbound listener, or pre-logon requirement.
Running it as `LocalSystem` would turn a compromise of the remotely controlled
Client into machine-level compromise. `NetworkService` has low local privilege
but authenticates to remote resources as the computer, not the signed-in user.[^network-service]
A normal Windows Service is consequently the wrong trust boundary today.

Windows also supports per-user service templates: the OS creates an instance
when a user signs in, runs it in that user's security context, and stops and
deletes it at sign-out.[^per-user-service] This is architecturally attractive,
but the template is machine configuration under `HKLM` and is substantially
more installation and native-service machinery than the current npm-delivered,
non-elevated product needs.

### Task Scheduler principals and settings

The logon type is a security decision, not merely a startup preference:

- `InteractiveToken` runs only in an existing interactive session. This is the
  desired scope because the Client is defined to act as that signed-in user.
- `S4U` stores no password but Microsoft explicitly states that it has no
  network or encrypted-file access. It cannot maintain Odyshell's outbound
  connection.
- `Password` supplies credentials at registration and runs as a batch logon. It
  can support a logged-out task, but changes installation and credential
  management into administrator-grade concerns.
- `ServiceAccount` selects `LocalSystem`, `LocalService`, or `NetworkService`,
  none of which is the user's workspace identity.

These semantics are defined by `TASK_LOGON_TYPE` and the Task Scheduler security
model.[^task-logon][^task-security] A limited interactive task also preserves
least privilege under UAC; it should never request `RunLevel=Highest` merely to
stay resident.[^task-security]

For a long-running Client task, configure:

- an at-logon trigger for the exact user;
- `InteractiveToken` and `RunLevel=Limited`;
- `ExecutionTimeLimit=PT0S` (the default is 72 hours);
- `MultipleInstances=IgnoreNew`;
- restart-on-failure with a bounded interval;
- start and continued execution on battery;
- no idle-only or network-profile condition; the Client already reconnects
  across transient network loss.

Microsoft documents indefinite execution, restart controls, duplicate-instance
policies, battery controls, and the fact that the `Hidden` switch affects only
the Task Scheduler UI.[^task-settings][^task-hidden]

### GUI-subsystem launcher

The launcher is the Windows equivalent of Syncthing's application-level
`--no-console` mode. It should be a very small native executable with no UI and
these responsibilities:

1. Accept fixed, structured arguments from Task Scheduler; do not invoke a
   shell or reconstruct a command string.
2. Start the configured absolute `node.exe` with the absolute CLI and config
   paths, using `CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`.
3. Redirect stdin from an inert handle and stdout/stderr to a bounded local log
   or null handles. Never inherit a terminal.
4. Put the child in a job object configured with
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so stopping or crashing the launcher
   cannot orphan Node or operation subprocesses.[^job-objects]
5. Wait for Node and return the same exit code. This lets Task Scheduler's
   failure recovery and status describe the actual Client rather than an
   already-exited bootstrap process.
6. Keep the launcher and task definition immutable except to the owning user
   and administrators. Do not place enrollment tokens or secrets in command
   arguments, task metadata, or logs.

`CREATE_NO_WINDOW` is explicitly defined for running a console application
without a console window.[^creation-flags] Node exposes a related `windowsHide`
option for child processes, but using `detached: true` on Windows gives the
child a new console and requires disconnected stdio plus `unref()` for parent
independence.[^node-child] That pattern is useful inside an application, but it
would make Task Scheduler observe only a short-lived bootstrapper. A waiting
launcher provides clearer ownership and recovery.

### PowerShell and script-host launchers

Windows PowerShell documents `-WindowStyle Hidden`, and `Start-Process` can also
request a hidden child window.[^ps-window-style][^start-process] Those are window
presentation controls. They are not the same contract as a Windows-subsystem
image or `CREATE_NO_WINDOW`.

A PowerShell wrapper also creates avoidable complexity at the security and
lifecycle boundary: command-line quoting crosses two parsers, an on-disk script
becomes executable configuration, Task Scheduler supervises the shell rather
than Node, and stopping the wrapper does not by itself define what happens to
the entire child tree. PowerShell is suitable for installing and inspecting
the task, but it should not be the production runtime host.

`wscript.exe` plus a VBScript/JScript wrapper is another historical way to
avoid a console. It still leaves the same script integrity, argument handling,
logging, and child-supervision problems. It offers no advantage over a small
purpose-built launcher for a security-sensitive remote execution client.

## Patterns in established open-source tools

### Syncthing: the closest match

Syncthing's upstream Windows guidance prefers startup at user logon for almost
all end-user scenarios. Its Task Scheduler action invokes `syncthing.exe`
directly with the application's own `--no-console --no-browser` flags, removes
the execution time limit, and discusses battery conditions.[^syncthing-autostart]
It reserves a Windows Service for mostly headless servers and explicitly warns
against `LocalSystem`, recommending a minimally privileged account instead.

This is the closest analogue to Odyshell: user-owned files, persistent network
activity, and no need for privileged machine startup. The important detail is
that Syncthing itself implements the no-console behavior; Task Scheduler's
hidden setting does not provide it.

Syncthing also warns that stopping its scheduled task may terminate only its
monitor process.[^syncthing-autostart] Odyshell should not copy that process-tree
gap. The job-object ownership requirement above makes task stop and launcher
failure fail closed.

### Tailscale and cloudflared: machine daemons

Tailscale runs `tailscaled` as a Windows Service. Its upstream implementation
integrates with `svc.Run`, reports SCM state, handles stop and session-change
events, and supervises a child process.[^tailscale-source] That complexity is
justified because Tailscale manages a machine network interface and routing;
its trust boundary is not a signed-in user's workspace.

Cloudflared likewise installs an automatically started SCM service, writes to
the Windows Event Log, accepts service stop/shutdown controls, and configures
failure recovery.[^cloudflared-source] It is another example of a machine tunnel
daemon whose service boundary is appropriate independently of interactive
login.

### GitHub Actions Runner and WinSW: service wrappers

The GitHub Actions Runner installs its machine agent as a real Windows Service;
the upstream `ServiceBase` implementation supervises and restarts the listener
process.[^actions-runner-docs][^actions-runner-source] WinSW generalizes this
pattern for arbitrary executables and provides service account, working
directory, logging, stop, and restart configuration.[^winsw]

Both demonstrate what Odyshell should use if it adopts an elevated,
boot-to-shutdown agent later. They do not remove the need to choose and maintain
a correct service identity, and they are larger than necessary for a Client
whose lifecycle intentionally matches user login.

## Security and reliability acceptance criteria

The Windows implementation is complete only when automated tests or an
installer-level test harness verifies all of the following:

- closing every terminal used for `npm install`, `ods up`, and diagnostics does
  not stop the Client;
- no console or PowerShell window appears at install, manual task start, logon,
  restart-after-crash, or update;
- the task principal is the exact current user, `InteractiveToken`, and
  `Limited`; registration fails closed if those properties differ;
- no password, enrollment token, client identity, or secret appears in the task
  XML, process command line, launcher file, or logs;
- the Client can read only the workspace allowed by its user token and local
  Odyshell policy, and it can make the required outbound connection;
- stopping/unregistering one Profile terminates that Profile's launcher, Node
  Client, and operation descendants without affecting another Profile;
- a second trigger does not create a duplicate instance;
- a nonzero Client exit causes the configured bounded restart, while an
  intentional stop does not enter a restart loop;
- logoff stops the per-user instance, the next logon starts one instance, and
  battery/network transitions do not permanently disable it;
- paths containing spaces, quotes, non-ASCII text, and argument-looking
  substrings cannot alter the executable or argument boundaries;
- replacing the launcher, CLI, or config from another unprivileged account is
  denied.

## Sources

All external sources below are Microsoft documentation or upstream project
documentation/source.

[^about-services]: Microsoft, [About Services](https://learn.microsoft.com/en-us/windows/win32/services/about-services).
[^session-zero]: Microsoft, [Service Changes for Windows Vista](https://learn.microsoft.com/en-us/windows/win32/services/service-changes-for-windows-vista).
[^service-access]: Microsoft, [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights).
[^service-users]: Microsoft, [Service User Accounts](https://learn.microsoft.com/en-us/windows/win32/services/service-user-accounts).
[^service-logon]: Microsoft, [Guidelines for Selecting a Service Logon Account](https://learn.microsoft.com/en-us/windows/win32/ad/guidelines-for-selecting-a-service-logon-account).
[^network-service]: Microsoft, [NetworkService Account](https://learn.microsoft.com/en-us/windows/win32/services/networkservice-account).
[^per-user-service]: Microsoft, [Per-user services in Windows](https://learn.microsoft.com/en-us/windows/application-management/per-user-services-in-windows).
[^task-logon]: Microsoft, [`TASK_LOGON_TYPE`](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type).
[^task-security]: Microsoft, [Security Contexts for Running Tasks](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).
[^task-hidden]: Microsoft, [`TaskSettings.Hidden`](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-hidden).
[^task-settings]: Microsoft, [`New-ScheduledTaskSettingsSet`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps).
[^subsystem]: Microsoft, [`/SUBSYSTEM` linker option](https://learn.microsoft.com/en-us/cpp/build/reference/subsystem-specify-subsystem?view=msvc-170).
[^creation-flags]: Microsoft, [Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).
[^ctrl-close]: Microsoft, [`CTRL+CLOSE` signal](https://learn.microsoft.com/en-us/windows/console/ctrl-close-signal).
[^job-objects]: Microsoft, [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
[^ps-window-style]: Microsoft, [`about_PowerShell_exe`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).
[^start-process]: Microsoft, [`Start-Process`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1).
[^node-child]: Node.js, [`child_process`](https://nodejs.org/api/child_process.html).
[^syncthing-autostart]: Syncthing, [Starting Syncthing Automatically](https://docs.syncthing.net/users/autostart.html#windows).
[^tailscale-source]: Tailscale, [`tailscaled_windows.go`](https://github.com/tailscale/tailscale/blob/main/cmd/tailscaled/tailscaled_windows.go).
[^cloudflared-source]: Cloudflare, [`windows_service.go`](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/windows_service.go).
[^actions-runner-docs]: GitHub, [Configuring the self-hosted runner application as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application).
[^actions-runner-source]: GitHub Actions Runner, [`RunnerService.cs`](https://github.com/actions/runner/blob/main/src/Runner.Service/Windows/RunnerService.cs).
[^winsw]: WinSW, [Windows Service Wrapper](https://github.com/winsw/winsw) and [XML configuration reference](https://github.com/winsw/winsw/blob/v3/docs/xml-config-file.md).
