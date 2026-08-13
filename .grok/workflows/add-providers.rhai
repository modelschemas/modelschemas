let meta = #{
    name: "add-providers",
    description: "Implement one isolated provider adapter per worktree and open a PR",
    phases: [
        #{ title: "Implement", detail: "one adapter per provider in an isolated worktree" },
        #{ title: "Collect", detail: "summarize PR URLs and failures" },
    ],
    when_to_use: "When adding the docs/providers-to-add.md batch as isolated adapter PRs",
};

let result_schema = #{
    "type": "object",
    "required": ["provider", "status", "branch", "pr_url", "notes"],
    "properties": #{
        "provider": #{ "type": "string" },
        "status": #{ "type": "string" },
        "branch": #{ "type": "string" },
        "pr_url": #{ "type": "string" },
        "notes": #{ "type": "string" },
    },
};

const ALL_PROVIDERS = [
    "mistral",
    "replicate",
    "groq",
    "fireworks",
    "together",
    "voyage",
    "cohere",
    "deepseek",
    "moonshot",
    "dashscope",
    "deepgram",
    "assemblyai",
    "runway",
    "cartesia",
    "perplexity",
    "cerebras",
    "sambanova",
    "jina",
    "stability",
    "bfl",
    "kling",
    "hyperbolic",
    "novita",
];

let listed = if args == () { () } else { args.providers };
let providers = if listed == () { ALL_PROVIDERS } else { listed };

fn adapter_prompt(id) {
    let p = "";
    p += "Implement ONE modelschemas provider adapter and open a GitHub PR.\n";
    p += "You own only provider id: ";
    p += id;
    p += "\n\n";
    p += "Read first (use read_file / grep, do not invent the contract):\n";
    p += "1. src/server/providers/adapters/hints.json — your entry\n";
    p += "2. src/server/providers/load-adapters.ts — export contract\n";
    p += "3. src/server/providers/openai.ts and grok.ts — simple adapter shape\n";
    p += "4. src/server/providers/openai-compat.ts — helper for OpenAI-compatible APIs\n";
    p += "5. src/server/providers/types.ts — ProviderConfig / Derivation / skippedResult\n";
    p += "6. src/server/ingest/sync.ts classifyAndBundle — how schemas are extracted\n";
    p += "7. src/server/providers/byteplus.test.ts — fetch mocking style if you need it\n\n";
    p += "Isolation rules (do not break these):\n";
    p += "- Create branch feat/provider-";
    p += id;
    p += " from the current HEAD.\n";
    p += "- Add ONLY these files: src/server/providers/adapters/";
    p += id;
    p += ".ts and src/server/providers/adapters/";
    p += id;
    p += ".test.ts\n";
    p += "- Do NOT edit index.ts, types.ts, seed-providers.ts, classify.test.ts, wrangler files, or any other provider.\n";
    p += "- Do NOT print, commit, or log secret values.\n\n";
    p += "Adapter contract:\n";
    p += "- export const provider: ProviderConfig\n";
    p += "- id must be exactly ";
    p += id;
    p += "\n";
    p += "- specSourceUrl and modelsEndpoint required (https)\n";
    p += "- authEnvVar is the secret name from hints.json\n";
    p += "- defaultDerivation: upstream-spec if you fetch the provider's own document; generated if you use openai-compat; docs-derived if you hand-write from prose; probe-verified only if you actually probed live.\n";
    p += "- fetchSpec: keyless whenever the spec is public. Use fetchOpenApi from types.ts for json/yaml.\n";
    p += "- listModels: skip via skippedResult when the secret is absent. Never throw on a missing key.\n";
    p += "- classify: generation endpoints only (chat|image|video|audio|embeddings|moderation). Platform/admin/files/fine-tune/batches/rerank (unless we have that activity) return null.\n";
    p += "- Prefer a real published spec from hints.json. If the hinted URL 404s, hunt (docs, GitHub, Stainless .stats.yml). If the API is OpenAI-compatible and has no spec, use fetchOpenAiCompatibleSpec + classifyOpenAiCompat + listOpenAiCompatibleModels.\n\n";
    p += "Tests (vitest, no network):\n";
    p += "- classify: at least one hit per claimed activity and at least one null/platform path\n";
    p += "- listModels({}): skipped is set and models is empty\n";
    p += "- mock fetch if you exercise fetchSpec; do not call live APIs in unit tests\n\n";
    p += "Verify: bun run test src/server/providers/adapters/";
    p += id;
    p += ".test.ts && bun run typecheck\n";
    p += "Format the new files with prettier. Lefthook runs on commit — never --no-verify.\n\n";
    p += "Git / PR:\n";
    p += "git checkout -b feat/provider-";
    p += id;
    p += "\n";
    p += "Commit: feat(providers): add ";
    p += id;
    p += " adapter\n";
    p += "git push -u origin HEAD\n";
    p += "gh pr create --base feat/provider-adapter-isolation --title \"feat(providers): add ";
    p += id;
    p += " adapter\" --body \"Adds the ";
    p += id;
    p += " adapter as a new file under src/server/providers/adapters/. Auto-registered. Depends on the isolation PR.\"\n";
    p += "If push/PR fails, say so in notes. Return status opened only when a PR URL exists.\n";
    p
}

if providers.len() == 0 {
    pause("verification", "Pass args.providers as a non-empty array of provider ids.");
}

phase("Implement");
log("Implementing " + providers.len().to_string() + " adapter(s)");

let jobs = [];
for id in providers {
    jobs.push(#{
        prompt: adapter_prompt(id),
        label: "adapter:" + id,
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: result_schema,
    });
}
let results = parallel(jobs);

phase("Collect");
let opened = [];
let failed = [];
let skipped = [];
let i = 0;
for r in results {
    let id = providers[i];
    if r == () || !r.success || r.output == () {
        failed.push(#{ provider: id, reason: "agent failed or returned no structured output" });
    } else if r.output.status == "opened" && r.output.pr_url != () && r.output.pr_url != "" {
        opened.push(r.output);
    } else if r.output.status == "skipped" {
        skipped.push(r.output);
    } else {
        failed.push(r.output);
    }
    i += 1;
}

let summary = "";
summary += opened.len().to_string();
summary += " opened, ";
summary += failed.len().to_string();
summary += " failed, ";
summary += skipped.len().to_string();
summary += " skipped";
log(summary);

let report = "# add-providers\n\n" + summary + "\n\n";
if opened.len() > 0 {
    report += "## Opened\n";
    for item in opened {
        report += "- ";
        report += item.provider;
        report += ": ";
        report += item.pr_url;
        report += "\n";
    }
    report += "\n";
}
if failed.len() > 0 {
    report += "## Failed\n";
    for item in failed {
        report += "- ";
        report += json_encode(item);
        report += "\n";
    }
    report += "\n";
}
if skipped.len() > 0 {
    report += "## Skipped\n";
    for item in skipped {
        report += "- ";
        report += json_encode(item);
        report += "\n";
    }
}

let path = write_scratch_file("report.md", report);
complete(#{
    summary: summary,
    opened: opened,
    failed: failed,
    skipped: skipped,
    path: path,
});
