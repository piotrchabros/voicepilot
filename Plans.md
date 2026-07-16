# Real-Time Sales Assistant Plans.md

作成日: 2026-07-15
正本: task ledger（product contract は root `spec.md`、precedence: spec.md > Plans.md）

---

## Phase 0: Baseline & guardrails

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 0.1 | [lane:fast] [tdd:skip:tooling-only] Lint/formatter baseline 導入（biome、`npm run lint` + `npm run format:check`） | lint スクリプトが exit 0、CI 相当コマンドが README に記載 | - | cc:完了 [ffea6b1] |
| 0.2 | [lane:gate] [tdd:required] Log hygiene: transcript/hint 本文を debug モード以外のログから排除（`pipeline/index.ts` の turn-end / hint ログを COPILOT_DEBUG ゲートで検証） | DEBUG off で起動したログに通話本文が 0 件（テストで検証）、spec.md §4.4 準拠 | - | cc:完了 [3e5edc0] |

## Phase 1: EU compliance hardening（既存コードの是正）

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 1.1 | [lane:gate] [tdd:required] Soniox EU endpoint: `SONIOX_WS_URL` config 化 + boot assertion（EU host allowlist に解決先が一致しなければ起動拒否）。`stt-soniox.ts:26` と `scripts/soniox-check.mjs` の hardcode を除去。EU hostname は live docs から取得（unknown → 調査 evidence を残す） | 非 EU URL で起動失敗するテスト green、EU URL で live smoke 成功 | 0.1 | blocked（EU region 未有効 — console で有効化後 smoke 再実行; code merged [51e0f3c]） |
| 1.2 | [lane:gate] [tdd:skip:config-only] Secrets 一本化: `.env` + zod fail-fast、`.soniox-key` は deprecated fallback（warn 出力、chmod 600） | 必須 env 欠落で boot が明示エラー、warn が出る | 1.1 | cc:完了 [c37759b] |
| 1.3 | [lane:gate] [tdd:skip:human-legal] DPA/法務ブロッカー台帳: Soniox EU region 有効化確認、Soniox/Twilio DPA 締結状況、consent 文言（PL）法務レビュー、rep 監視（労働法）注記を `docs/compliance.md` に記録。**real-prospect call はこれらが green になるまで禁止** | 台帳が存在し、各項目に 状態（done/unknown/blocked）と根拠リンクが付く | - | cc:完了 [85ae946] |

## Phase 2: AudioSource seam（transport-agnostic 化）

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 2.1 | [lane:gate] [tdd:required] `AudioSource`/`AudioFrame`/`SpeakerRole`/`separation` 型を `src/shared` に定義（spec.md §2 の Float32 決定に従う） | 型 + parameterized contract test suite（frame 形状 / t 単調増加 / end 一回 / health 発火）が存在し green | 0.1 | cc:完了 [78bb76e] |
| 2.2 | [lane:gate] [tdd:required] `FileAudioSource`: 既存 `wav.ts` を包んで AudioFrame を natural cadence で emit（bench.ts と統合） | contract suite を pass、bench が FileAudioSource 経由で動く | 2.1 | cc:完了 [3a86ea6] |
| 2.3 | [lane:gate] [tdd:required] `SystemAudioSource`: 既存 sidecar demux（`main/sidecar.ts`）を adapter で包む。mic→rep / loopback→prospect、`separation:'mixed'`、sample-count 由来の `t` を付与 | contract suite pass、既存 E2E がこの seam 経由で動作 | 2.1 | cc:完了 [ced2a95] |
| 2.4 | [lane:gate] [tdd:required] Health events end-to-end: sidecar exit / device loss / Soniox 切断 → UI banner（現在は log のみ） | 各障害の注入テストで `health {ok:false}` が UI まで届く | 2.3 | cc:完了 [7abf03f] |

## Phase 3: Classification & playbook（speculation は維持）

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3.1 | [lane:gate] [tdd:required] Tier-1 classifier（PL ルール）: settled prospect turn に spec.md §3 の label を付与。`smalltalk|none` はカード抑制。`separation:'mixed'` 時は閾値引き上げ | PL fixture corpus（各 label + 語形変化 + 抑制ケース）green、判定 <200ms | 2.1 | cc:完了 [bb133ad] |
| 3.2 | [lane:gate] [tdd:required] Playbook YAML 化: `{id,trigger,headline,line,detail}` schema、trigram マッチ維持、`playbook.tsv` → `playbook/*.yaml` 移行 | 既存 playbook テスト + schema validation テスト green、tsv 削除 | 3.1 | cc:完了 [82d6653] |
| 3.3 | [lane:gate] [tdd:required] Suggestion payload + latency instrumentation: per-stage timestamp（transport tag 付き）を suggestion に添付、bench に集計を追加 | bench 出力に transport 別 p50/p95 が出る | 2.2 | cc:完了 [bb602a6] |
| 3.4 | [lane:gate] [tdd:required] No-sentiment guard: label set を閉集合で固定、Tier-2/生成 prompt に感情推論禁止を明記、これを assert するテスト | 禁止語 assert テスト green、spec.md §1 non-goals 準拠 | 3.1 | cc:完了 [0578c78] |
| 3.5 | [lane:fast] [tdd:required] Echo/headset 警告: mic×loopback 相関が閾値超過で UI 警告 | 合成エコー音源で警告が発火するテスト green | 2.3 | cc:完了 [3c95e30] |

## Phase 4: Operator chrome（Transport B の UI 完成）

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 4.1 | [lane:gate] [tdd:required] Consent gate (B): 通話ごとの affirmation を Start 前に必須化、timestamp 付きで記録、録音インジケータ常時表示、announcement script 表示 | affirmation なしで capture が開始しないテスト green、記録ファイルに timestamp | 2.3 | cc:完了 [93d5a2e] |
| 4.2 | [lane:gate] [tdd:skip:ui-manual-qa] Transport chrome: mode 表示、health banner（2.4 の event を表示）、suggestion card（headline ≤6 words + line、replace 方式は既存踏襲） | 手動 QA チェックリスト全項目 pass（スクリーンショット evidence） | 2.4, 3.3 | cc:完了 [262ccee]（手動 QA: boot evidence 取得済み docs/qa-evidence/、full checklist はユーザー実行推奨） |

## Phase 5: Transport A — Twilio PSTN（着手時に service 抽出）

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 5.1 | [lane:gate] [tdd:required] Pipeline service 抽出: `src/pipeline` を Fastify service に lift、Electron は capture-forwarder client 化（localhost WS、binary frame、127.0.0.1 bind + session token） | 既存全テスト green のまま Transport B が service 経由で E2E 動作 | Phase 4 | cc:TODO |
| 5.2 | [lane:gate] [tdd:required] Twilio dial+bridge: `POST /call`（要 auth）、TwiML `<Dial answerOnBridge>`、region ie1/edge dublin、webhook signature 検証（public URL 基準） | 実電話 2 台で通話成立、署名不正 request が 403 のテスト green | 5.1, 1.3 | cc:TODO |
| 5.3 | [lane:gate] [tdd:skip:config-legal] Consent announcement (A): prospect leg 接続前 `<Say pl-PL>`、文言は config（法務未確定なら placeholder + 起動時 warn） | 実呼で announcement が bridging 前に再生される | 5.2 | cc:TODO |
| 5.4 | [lane:gate] [tdd:required] `TwilioAudioSource`: media WS parser（fixture テスト）、μ-law LUT + 8→16k upsample（参照ベクタテスト）、signed token TTL + callSid bound、token 不正/欠落で close | fixture/参照ベクタ/token テスト green、contract suite pass | 5.1 | cc:TODO |
| 5.5 | [lane:gate] [tdd:required] Track mapping 実証: 各 track 10s を wav dump して耳で確認、`TRACK_MAP` を pin するテスト追加 | dump 手順の evidence + pin テスト green（逆転検出可能） | 5.4 | cc:TODO |
| 5.6 | [lane:gate] [tdd:required] Teardown/reconnect: status callback と media stop の冪等 teardown、Soniox 再接続 buffer 上限の整合（現 10s vs 計画 2s → spec 決定を反映）、health 経路 | 二重 stop / race / reconnect のテスト green | 5.4 | cc:TODO |
| 5.7 | [lane:release] [tdd:skip:release-gate] E2E 実呼検証 + PL WER 測定（8kHz A vs 16kHz B）+ evidence pack → closeout | 実呼で card 表示 <1.5s、WER 比較レポートが docs に存在 | 5.5, 5.6 | cc:TODO |

## Phase 6: Knowledge base + analysis panel（spec.md §7）

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 6.1 | [lane:gate] [tdd:required] KB loader + per-section retrieval: `knowledge/**/*.md` を `##` 見出しで chunk、playbook の trigram 関数を再利用した per-section top-K。`customers/<name>.md` は丸ごと読み込み（always-injected、retrieval 対象外）。emotion-inference 指示の denylist lint を load 時に実行 | PL fixture corpus（語形変化 query / top-K / MIN_SCORE / denylist 検出）green、`knowledge/` 欠落時は warn + 空で安全 | 3.2 | cc:完了 [dca7a98] |
| 6.2 | [lane:gate] [tdd:required] `TranscriptState.renderRollingWindow()`: cloud 用 rolling window renderer（spec.md §3 の許可条項）。cache-locked `renderPrompt()` と状態共有・変更なしを invariant テストで固定 | window 上限テスト + `renderPrompt()` 出力不変テスト green | - | cc:完了 [e92434b] |
| 6.3 | [lane:gate] [tdd:required] Cloud LLM client: `AnalysisLlm` narrow iface + `Generation` 互換 cancel（AbortController）。`LLM_API_URL`/`LLM_API_KEY`/region/deployment-class を .env + zod、EU allowlist boot assertion（deployment class 込み、https 必須、非 EU で起動拒否）。テストは `FakeCloudClient` のみ（CI で実 API 禁止） | 非 EU / plain-http URL で boot 失敗テスト green、cancel contract テスト green | 1.2 | cc:WIP |
| 6.4 | [lane:gate] [tdd:required] `AnalysisEngine`（HintEngine の sibling、src/pipeline 内・transport-agnostic）: settled prospect turn-end trigger、~1.5s debounce、cancel-previous（queue 禁止）、閉スキーマ出力 `{stage, suggested_questions≤3, next_steps?}`（zod validate、非準拠は drop）、no-sentiment guard を prompt と output 両方に適用（3.4 の拡張）、"as of turn N" stamp、cloud 送信 feature flag（default OFF）、log hygiene（HTTP error body 含む） | cancel テスト（10 連投→1 生存）、no-sentiment prompt/output テスト、log-hygiene テスト、flag OFF 時 network 呼び出し 0 件テスト green | 6.1, 6.2, 6.3 | cc:TODO |
| 6.5 | [lane:gate] [tdd:required] `AnalysisMsg` wire + IPC: `FromPipeline` に追加（plain-serializable、Phase 5 の WS bridge 互換）、pipeline-host routing、`CopilotBridge.onAnalysis` + preload | 型 + routing + bridge のテスト green | 6.4 | cc:TODO |
| 6.6 | [lane:gate] [tdd:skip:ui-manual-qa] Analysis panel window: 別 BrowserWindow（`setContentProtection` 必須、既存 overlay の recipe 再利用）、default hidden、operator toggle + 手動 refresh-now、stale 時 grey-out、cloud 処理インジケータ表示。既存 hint card は無変更 | 手動 QA チェックリスト pass（content-protection A/B、default hidden、card 無変更、スクリーンショット evidence） | 6.5 | cc:TODO |
| 6.7 | [lane:gate] [tdd:required] Customer brief 選択: pre-Start consent 画面に dropdown（default: none）、`InitMsg` に brief フィールド追加、consent affirmation 記録に processor set（`soniox` / `soniox+llm`）を含める（4.1 の拡張） | brief 注入テスト + none-path 安全テスト + affirmation 記録テスト green | 6.1, 4.1 | cc:WIP |
| 6.8 | [lane:gate] [tdd:skip:human-legal] Compliance 拡張: `docs/compliance.md` に LLM processor 行を追加（DPA、retention/ZDR 実態、per-project region 証跡、subprocessor、consent 範囲の法務確認、brief の lawful-basis note、KB curation rule）。`customers/` を .gitignore に追加、brief テンプレート（data-minimization 注記付き）作成。**ledger green まで real-prospect への cloud analysis 禁止（flag OFF 維持）** | ledger 行が status+evidence 付きで存在、.gitignore entry、テンプレート存在 | - | cc:完了 [b3b4a3a] |
| 6.9 | [lane:gate] [tdd:required] Bench/metrics + Phase 5 merge note: analysis latency p50/p95 + tokens/call を bench に追加（`BenchStage` とは分離）、card p95 が baseline 不変であることを検証。AnalysisEngine/`AnalysisMsg` が 5.1 service lift に乗る旨を docs に記録 | bench 出力に analysis p50/p95 + tokens/call、card p95 不変 evidence、merge note 存在 | 6.4, 6.5 | cc:TODO |

Phase 6 の v1 除外（recorded、spec.md §7）: panel 内 objection responses（hint card が SSOT）、per-turn 自動 refresh、post-call summary、embeddings retrieval。

---

## Stage gate 対応

1. 検証・調査 = Phase 0–1（unknown 解消: EU endpoint/region、DPA、法務文言）
2. 実装計画確定 = 本 Plans.md + spec.md（承認で確定）
3. 実装(TDD) = Phase 2–5 の [tdd:*] タグに従う
4. レビュー = 各 Phase 完了時に `/harness-review`（Phase 5 は実呼 evidence 必須）
5. PR closeout = Phase 単位。release は 5.7 の [lane:release] gate のみ

## unknown_data

- Soniox EU endpoint の正確な hostname（live docs で確認、1.1 で解消）
- Soniox account の EU region 有効化状態（enabled-by-request、1.3）
- Soniox 側 audio retention / ZDR 条件（DPA で確認、1.3）
- Twilio ie1 での `<Start><Stream>` both_tracks の us1 同等性（5.2 で確認）
- PL WER @8kHz telephony（5.7 の kill-check、A の実用性判断）
- Tier-2 生成の実測 latency（3.3 の計測で解消）
- Consent 文言（法務、1.3 — agent は文言を発明しない）
- Cloud LLM vendor/region の選定（human 決定。2026-07 調査: Anthropic 直 API に EU inference geo なし — Claude の EU 処理は Bedrock/Vertex EU region 経由。OpenAI EU residency は sales-gated + 新規 project のみ。Azure は EU Data Zone / regional deployment のみ可（Global Standard 不可）。Mistral は EU 社だが ZDR は Scale plan のみ。6.3 の allowlist は config 駆動とし、選定後に pin） — 6.8 で解消
- 選定 vendor の ZDR/retention 実条件（"stateless 呼び出し" ≠ 先方 zero retention、abuse-monitoring 窓が実 retention） — 6.8
- 既存 consent 文言が第二 processor（LLM）+ brief data を包含するか（blocked(human)、法務） — 6.8
- Analysis の実測 latency / tokens per call / per-call cost — 6.9 で計測
- KB 実サイズでの trigram retrieval 再現率（≤200 sections 想定。超過・品質不足時のみ embeddings を別決定で再検討） — 6.9 以降
