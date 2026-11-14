# CourseLens

CourseLens is a course study assistant with evidence retrieval and long-term study memory. Its command-line agent uses TypeScript, LangGraph.js and a read-only Research subgraph. Docling normalizes course documents and LightRAG retrieves evidence.

## Browser demo

Create separate student and operator tokens, then start PostgreSQL and the demo app.

```sh
export COURSELENS_STUDENT_TOKEN="$(openssl rand -hex 24)"
export COURSELENS_OPERATOR_TOKEN="$(openssl rand -hex 24)"
docker compose -f compose.courselens.yml up --build
```

Open http://127.0.0.1:8080. Enter the student token and ask **Check the FIT2004 lecture and plan practice**. The scripted demo intentionally proposes an overbroad claim, sends it back through verification and research, then shows a corrected answer and a plan. Approve it to generate review cards through MCP. Enter the operator token and open the trace to inspect routing and role events. The demo uses original sample text and a scripted model.

For a native run, start PostgreSQL with `compose.checkpoint.yml`, set `STUDY_CHECKPOINT_DATABASE_URL` and the tokens, and run `COURSELENS_DEMO=1 pnpm start`. Set `COURSELENS_DEMO=0` and configure the model, indexing and course data to run with your own materials. The live app keeps per-student learning memory in local SQLite files.

## Architecture and verification

LangGraph routes understanding, bounded research, tutoring, planning and independent verification through a shared state. PostgreSQL holds conversation checkpoints, authorized session IDs, run events and approved card jobs. Fastify serves the student page and cursor-based SSE events. An operator view shows events without the conversation text. The worker leases jobs, retries failures and invokes a review-card tool over MCP.

```sh
pnpm typecheck
pnpm build
pnpm eval:study
pnpm test:harness
```

Set `COURSELENS_TEST_DATABASE_URL` to a disposable PostgreSQL database to include the ownership, duplicate-request and worker-recovery integration check. Replay results verify fixed behavior. For a labeled live corpus, run `pnpm eval:retrieval cases.json` after indexing the courses. Each case contains `question`, `course`, optional `week`, and the `expectedDocumentIds` from the normalized documents. The script compares LightRAG and hybrid retrieval using Recall@4, Precision@4, HitRate@4, MRR, nDCG@4 and latency. Model quality requires a separately labeled answer set.

## Run the agent

Install Node.js 24, pnpm and uv. From the repository root:

```sh
pnpm install
pnpm agent:graph -- --fixture --scenario research
```

The fixture exercises the graph, tool calls and evidence output with a scripted model. For a live run, copy `.env.example` to `.env` and set `STUDY_MODEL_API_KEY`, `STUDY_MODEL_BASE_URL` and `STUDY_MODEL` for a compatible Chat Completions endpoint. The example base URL is for Alibaba Cloud Model Studio. Configure the indexing credentials in the same file and set the local course material paths in `config/sources.local.json` using the supplied example.

```sh
uv sync --project services/knowledge-service --python 3.12
pnpm scan
pnpm normalize -- course FIT2109
pnpm lightrag -- sync-course FIT2109
pnpm agent:graph -- --course FIT2109 --query "Summarize the course materials on testing."
```

Replace `FIT2109` with your indexed course. To keep a conversation across processes, start PostgreSQL and initialize its tables:

```sh
docker compose -f compose.checkpoint.yml up -d --wait
export STUDY_CHECKPOINT_DATABASE_URL=postgresql://courselens:courselens-local@127.0.0.1:55432/courselens
pnpm checkpoint:init
pnpm agent:graph -- --fixture --scenario continuity --persist
```

For live conversations, add `--persist` to the first call and pass the returned session ID as `--session ID` on subsequent calls.

## License

CourseLens source and documentation use the [MIT License](LICENSE).
