---
title: Local models (self-hosted LLMs)
---

# Local models

Run open-weight models on your own hardware and use them everywhere in Bee Flow —
direct chat, agents, automations, knowledge-base answers. Prompts never leave your
infrastructure and there is no per-token cost.

Bee Flow talks to any of these runtimes:

| Runtime | Best for | Default address | Downloads models over the API |
|---|---|---|---|
| **[Ollama](https://ollama.com)** | Getting started; laptops and single servers | `http://localhost:11434` | ✅ Yes |
| **[vLLM](https://docs.vllm.ai)** | Production GPU serving, high throughput | `http://localhost:8000/v1` | ❌ Loaded at start-up |
| **[llama.cpp](https://github.com/ggml-org/llama.cpp)** (`llama-server`) | GGUF models, CPU / Metal / CUDA / Vulkan | `http://localhost:8080/v1` | ❌ Loaded at start-up |
| **[LM Studio](https://lmstudio.ai)** | Desktop, point-and-click | `http://localhost:1234/v1` | ❌ Loaded in the app |
| **[SGLang](https://docs.sglang.ai)** | GPU serving, structured output | `http://localhost:30000/v1` | ❌ |
| **[LocalAI](https://localai.io)** | Chat + embeddings + image + audio in one | `http://localhost:8080/v1` | ❌ |
| **[TGI](https://huggingface.co/docs/text-generation-inference)** | Hugging Face production serving | `http://localhost:8080/v1` | ❌ |
| **[Jan](https://jan.ai)**, **[KoboldCpp](https://github.com/LostRuins/koboldcpp)** | Desktop / single-binary | `http://localhost:1337/v1`, `http://localhost:5001/v1` | ❌ |
| **Any OpenAI-compatible endpoint** | TensorRT-LLM, Ray Serve, an internal gateway… | — | ❌ |

They all speak the OpenAI `/v1/chat/completions` API, so anything not in this list
that does the same works under **OpenAI-compatible endpoint**.

## Connect a runtime

### The quickest path

1. Go to **Admin → AI → Providers**.
2. In the **Local models** card, press **🔍 Find running runtimes**.
3. Press **Connect** on whatever it found.

The scan probes the default addresses above on `localhost` and on
`host.docker.internal`, plus the `ollama` / `vllm` / `llamacpp` service names used by
Docker Compose. Anything reachable that is serving at least one model is offered.

If nothing is found, **+ Add manually** takes a runtime type, an address, and an
optional API key (only needed if you started the server with `--api-key`). Press
**Test connection** first — it reports whether the address answers *and* which models
it is serving, which is the thing that decides what shows up in the tier picker.

### With the bundled Ollama container

The self-host compose file ships an Ollama service behind the `local-llm` profile:

```bash
PROFILES="core local-llm" ./selfhost.sh
```

Then set `OLLAMA_URL=http://ollama:11434` in `.env` and restart. On boot the server
registers it automatically — no form to fill in.

By default the container has **no GPU reservation** so the profile starts on any
machine. Uncomment the `deploy.resources` block for the `ollama` service in
`docker-compose.from-registry.yml` (and install the NVIDIA container toolkit) to get
usable speed on anything above roughly 8B parameters.

### With environment variables

Any of these auto-registers a provider at start-up, which is the path to use for
Kubernetes and for immutable deployments:

| Variable | Runtime |
|---|---|
| `OLLAMA_URL` | Ollama |
| `VLLM_URL` | vLLM |
| `LLAMACPP_URL` | llama.cpp |
| `LMSTUDIO_URL` | LM Studio |
| `SGLANG_URL` | SGLang |
| `LOCAL_LLM_URL` + `LOCAL_LLM_TYPE` + `LOCAL_LLM_API_KEY` | anything else |

The variable is the declaration of intent: a provider created this way reappears on
every restart, so removing the variable is how you disconnect it permanently. It is
labelled **from environment** in the admin UI to make that visible.

:::note Bee Flow in Docker, runtime on the host
`localhost` inside a container is the container. Use
`http://host.docker.internal:11434` (Docker Desktop) or the host's LAN address, and
make sure the runtime listens on more than loopback — for Ollama that means
`OLLAMA_HOST=0.0.0.0`.
:::

## Download models

For Ollama, open the runtime's **↓ Add model** panel. It offers a curated starter
list with the VRAM each one needs, and accepts any tag from the
[Ollama library](https://ollama.com/library) — including
`hf.co/<user>/<repo>:<quant>` for a GGUF straight from Hugging Face. The download
streams progress into the UI. `docker compose exec ollama ollama pull qwen3:8b` does
the same thing from a shell.

The other runtimes load their model when the process starts, so you choose it on the
command line instead:

```bash
# vLLM
vllm serve Qwen/Qwen3-8B --port 8000

# llama.cpp
llama-server -hf unsloth/Qwen3-8B-GGUF:Q4_K_M --port 8080 --jinja
```

`--jinja` matters for llama.cpp: without it the server does not do OpenAI-style tool
calling, and Bee Flow agents need tools.

## Assign models to tiers

Connected runtimes feed the same picker as every cloud provider. Under
**Admin → AI → Chat Models**, each tier gets a model; local ones are grouped under
the runtime's name.

A reasonable starting point on a single 24 GB GPU:

| Tier | Model | Why |
|---|---|---|
| Fast | `qwen3:4b` | Chat titles, classification, quick answers |
| Flow (Direct) | `qwen3:8b` | Everyday chat with tools |
| Thinking | `qwen3:30b-a3b` | Mixture-of-experts: 30B quality at ~3B speed |
| Deep Thinking | `gpt-oss:20b` or `deepseek-r1:32b` | Long chain-of-thought work |

You can mix freely — a local model on Fast and a cloud model on Deep Thinking is a
common way to cut cost without giving up frontier quality on hard tasks.

### Reasoning models

Bee Flow detects open-weight reasoning families (Qwen3, DeepSeek-R1, QwQ, gpt-oss,
Magistral, GLM, MiniMax, Nemotron, Phi-4 Reasoning…) and shows the **Reasoning
Effort** control for them. The setting is translated per runtime:

- **Ollama** → the `think` parameter (`low` / `medium` / `high`, or off).
- **vLLM / SGLang / llama.cpp** → `chat_template_kwargs.enable_thinking`.

Thinking output is separated from the answer either from the model's
`reasoning_content` field or from in-band `<think>…</think>` tags, so it renders in
the same collapsible thinking panel as Claude's or GPT-5's.

For Ollama the capability flags come from the runtime itself (`/api/show`), so a tag
that genuinely cannot think or call tools is not advertised as if it could.

## Embeddings and the knowledge base

A local runtime can serve embeddings too. Pull an embedding model
(`ollama pull nomic-embed-text`), then pick the runtime and the model under
**Admin → AI → Embeddings**.

Re-embedding is required if you switch embedding models — vectors from different
models are not comparable. Existing knowledge-base content must be re-ingested.

## Cost accounting

Models served from a connected local runtime are billed at **€0** in usage reporting
and in any per-user or per-org spend limit. This is deliberate and specific: an
open-weight model has a published price at every cloud host that serves it, and
inheriting one of those would charge a customer for their own hardware.

## Troubleshooting

**"Model … not found in any configured provider."**
The model list is cached for 60 seconds. Press **Test** on the runtime to re-probe,
or wait a minute. If the model was just downloaded outside Bee Flow, the cache
refresh picks it up on its own.

**The runtime is reachable but reports 0 models.**
Normal while vLLM is still loading weights, and normal for a fresh Ollama with
nothing pulled. Download a model and re-test.

**Tools are ignored / the model replies in prose instead of calling a tool.**
Not every open-weight model supports tool calling, and some runtimes need it enabled
explicitly (`--jinja` on llama.cpp, `--enable-auto-tool-choice --tool-call-parser …`
on vLLM). Qwen3, Llama 3.1+, Mistral, gpt-oss and Granite are reliable choices.

**Answers get cut off.**
The tier's max-tokens can exceed the runtime's context window. Raise it on the
runtime (`OLLAMA_CONTEXT_LENGTH`, vLLM's `--max-model-len`, llama.cpp's `-c`) or
lower the tier's ceiling.

**Everything is very slow.**
Check the model actually fits in VRAM — once it spills to system RAM, throughput
drops by an order of magnitude. Pick a smaller parameter count or a heavier
quantisation. Setting `OLLAMA_KEEP_ALIVE` keeps weights resident between turns, which
removes a reload from every request.

## Security

These runtimes have no authentication of their own. The bundled Ollama container
binds to `127.0.0.1` for that reason. If you expose one on a network, put it behind
a reverse proxy or start it with an API key (`vllm serve --api-key …`,
`llama-server --api-key …`) and enter that key when connecting the runtime.
