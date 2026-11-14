# CourseLens

CourseLens is a course study assistant with evidence retrieval and long-term study memory. Its command-line agent uses TypeScript, LangGraph.js and a read-only Research subgraph. Docling normalizes course documents and LightRAG retrieves evidence.

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
