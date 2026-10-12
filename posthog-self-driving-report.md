# PostHog Self-driving setup report

## Summary

PostHog Self-driving is configured for this web application: Session Replay, Error Tracking, and Support are enabled; native health, error, and support responders are armed; and GitHub Issues is connected as a warehouse source. Findings will start appearing in the [Self-driving inbox](https://us.posthog.com/project/643425/inbox) within about 30 minutes as scanners and scouts begin running.

No application source files were changed. The existing browser SDK configuration already permits exception capture and does not disable session recording.

## AI data processing

Approved by the wizard's organization-level gate.

## GitHub

Connected during this setup through the existing GitHub App integration.

| Repository                  | Warehouse source                       | Sync scope                                      | Status                                      |
| --------------------------- | -------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `modelschemas/modelschemas` | `01a12d86-a517-0000-6f7a-4ecead38cce9` | GitHub Issues only, incremental by `updated_at` | Connected by this setup; first sync started |

Additional GitHub tables can be enabled later from the data warehouse source UI if needed.

## Products enabled

| Product        | Status  | Notes                                                                                        |
| -------------- | ------- | -------------------------------------------------------------------------------------------- |
| Session Replay | Enabled | The web SDK does not disable recording. No recordings existed at setup time.                 |
| Error Tracking | Enabled | Browser exception capture is enabled in the existing SDK configuration.                      |
| Support        | Enabled | Tickets will arrive after an inbound email, inbox, or Slack channel is connected in PostHog. |

## Signal sources

| Signal source                          | Action                | Notes                                                                                                                 |
| -------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `signals_scout` / `cross_source_issue` | On by default         | No opt-out row existed, so no row was created.                                                                        |
| `health_checks` / `health_issue`       | Enabled               | Source config `01a12d7d-72d3-7cf9-8397-7c63605d09e0`.                                                                 |
| `error_tracking` / `issue_created`     | Enabled               | Source config `01a12d7d-756b-7e9a-9427-a9bdda4380ba`.                                                                 |
| `error_tracking` / `issue_reopened`    | Enabled               | Source config `01a12d7d-74a8-7a13-8eae-78fd31c44568`.                                                                 |
| `error_tracking` / `issue_spiking`     | Enabled               | Source config `01a12d7d-74c5-7d12-b906-b5f228168e7a`.                                                                 |
| `conversations` / `ticket`             | Enabled               | Source config `01a12d7d-744b-7bf2-ac4b-766e7557df6f`; waits for an inbound support channel.                           |
| `github` / `issue`                     | Enabled               | Source config `01a12d86-b334-7d89-9d83-4242db2cd96e`; warehouse sync is running.                                      |
| Session replay source row              | Skipped intentionally | Replay coverage is provided by the Replay Vision scanners below; the retired session-analysis source was not created. |

## Connected tools

| Tool                                                       | Selection | Result                                                                                 |
| ---------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| GitHub Issues                                              | Selected  | Connected by this setup; the Issues table is syncing from `modelschemas/modelschemas`. |
| Linear, Jira, Sentry, Zendesk, and all other catalog tools | Not used  | No responder was created.                                                              |

## Scout troop

**Verified daily run budget:** 100 runs/day; 0 used today and 100 remaining. The current early-access banner says: “Scouts are in early access. Each project gets up to 100 scout runs a day. Contact team-self-driving@posthog.com if you need more.”

| Active scout       | What it watches                                                        |
| ------------------ | ---------------------------------------------------------------------- |
| General            | Cross-product correlations and otherwise unowned surfaces.             |
| Product analytics  | Product flows, retention, lifecycle, stickiness, and path regressions. |
| Web analytics      | Traffic, attribution, landing-page health, bounce, and 404 changes.    |
| Observability gaps | Significant event activity that lacks an insight, dashboard, or alert. |

The other 24 built-in scouts are disabled to keep the troop selective. Error tracking is covered by native responders and Session Replay is covered by the Replay Vision scanners, so their duplicate scouts remain disabled. The remaining disabled scouts cover unconfirmed or unused surfaces: AI observability, APM, conversations, CSP violations, customer analytics, data pipelines, data warehouse, experiments, feature flags, insight alerts, logs, MCP calls, Replay Vision trend analysis, revenue, skills store, surveys, tasks, web vitals, and workflows; Inbox validation is disabled because this is a fresh setup with no resolved Self-driving work to validate.

## Custom scouts

No custom scouts were created: the proposed schema-validation-quality and developer-API-activation monitors were declined. They were considered because the repository captures validation, account, API-key, agent-registration, and subscription events; they would provide service-specific diagnostics beyond the active generic product-analytics coverage. Payments, LLM analytics, surveys, customer analytics, and operational pipelines were ruled out because the repository scan showed no corresponding confirmed PostHog surface.

If a custom scout is added later and becomes noisy, set its config’s `emit` value to `false` in PostHog to keep it running in dry-run mode.

## Replay Vision scanners

A scanner is an LLM that watches individual session recordings on a schedule and pushes clear defects to the Self-driving inbox. These are the only setup items that spend Replay Vision quota. Scanner findings arrive at half weight and need corroboration before they are promoted into an inbox report.

| Scanner                                  | Status  | Scope                                                                                          | Sampling | Estimate                                                                                                                 |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Modelschemas account setup breakage      | Created | Recordings that visit `/account`, the completion page for managing API keys after sign-in      | 50%      | 0 observations / 0 credits per month from the current seven-day sample; 5 credits per observation once recordings arrive |
| Modelschemas developer setup frustration | Created | Recordings with `$rageclick` only; intentionally not URL-scoped to keep monitor roles distinct | 100%     | 0 observations / 0 credits per month from the current seven-day sample; 5 credits per observation once recordings arrive |

The organization has 2,500 Replay Vision credits remaining and is not exhausted. No recordings existed at setup time, so both scanners are armed and will start working as soon as browser recordings arrive.

## Files created or modified

| Path                                                       | Change                                 |
| ---------------------------------------------------------- | -------------------------------------- |
| `posthog-self-driving-report.md`                           | Created: this setup report.            |
| `.claude/skills/replay-vision-setup/`                      | Installed workflow reference.          |
| `.claude/skills/replay-vision-scanners-core/`              | Installed scanner mechanics reference. |
| `.claude/skills/replay-vision-scanner-broken-experiences/` | Installed breakage-monitor brief.      |
| `.claude/skills/replay-vision-scanner-user-frustration/`   | Installed frustration-monitor brief.   |

## Follow-ups

- [ ] Connect an inbound Support channel (email, inbox, or Slack) in PostHog so the enabled Support responder can receive tickets.
- [ ] Generate browser traffic and recordings; both Replay Vision scanners currently have no historical sessions to inspect.
- [ ] Rate early scanner observations in Replay Vision with a thumbs up/down and a short note to tune their first prompts.

## What happens next

Fresh scout configurations are picked up within about 30 minutes and consume the verified daily scout budget. Findings cluster into reports in the [Self-driving inbox](https://us.posthog.com/project/643425/inbox); actionable reports can begin coding tasks.
