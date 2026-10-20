/**
 * マイグレーション。配列の i 番目が user_version = i+1 に上げるSQL。
 * 一度リリースしたSQLは書き換えず、末尾に追加する。
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    -- プロジェクト全体のプロファイル(全体の起動方法、QAの方法、API仕様の置き場所)
    profile_json TEXT,
    profile_status TEXT NOT NULL DEFAULT 'none',      -- none / draft / approved
    test_infra TEXT NOT NULL DEFAULT 'unknown',       -- unknown / present / insufficient / none
    allow_without_tests INTEGER NOT NULL DEFAULT 0,   -- テスト基盤整備前の通常タスクを人が許可したか
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    path TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,                               -- main / frontend / backend など
    default_branch TEXT NOT NULL,
    profile_json TEXT,                                -- リポジトリ単位のプロファイル(ビルド/テスト/規約)
    created_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'local',        -- local / paste / notion
    source_url TEXT,
    kind TEXT NOT NULL DEFAULT 'normal',              -- normal / test_infra
    state TEXT NOT NULL,                              -- 値の検証は src/orchestrator で行う
    held_from_state TEXT,                             -- needs_input / human_working に入る前の状態
    assignee TEXT,                                    -- agent / human / NULL
    review_rounds INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project_state ON tasks(project_id, state);

  -- タスクとworktreeの関係は必ずここを通す(複数リポジトリ対応、設計メモ5.3)
  CREATE TABLE task_repos (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    worktree_path TEXT NOT NULL UNIQUE,
    branch_name TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, repo_id)
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),             -- プロジェクト把握担当はタスクに属さない
    project_id INTEGER REFERENCES projects(id),
    role TEXT NOT NULL,
    model TEXT,
    state TEXT NOT NULL,                              -- running / succeeded / failed / timeout / cancelled
    verdict TEXT,
    summary TEXT,
    session_id TEXT,
    cost_usd REAL,
    structured_output TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX runs_task ON runs(task_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    run_id INTEGER REFERENCES runs(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_task ON events(task_id, id);

  CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    run_id INTEGER REFERENCES runs(id),
    kind TEXT NOT NULL,                               -- plan / impl-notes / review / qa-report / pr-draft など
    path TEXT NOT NULL,
    verdict TEXT,
    created_at TEXT NOT NULL
  );

  -- 人の承認と、レビュー/QAの合格。コミットに紐づけ、新しいコミットで失効させる
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    repo_id INTEGER REFERENCES repos(id),
    kind TEXT NOT NULL,                               -- plan / design / final / review / qa
    result TEXT NOT NULL,                             -- approved / rejected
    commit_sha TEXT,
    comment TEXT,
    invalidated_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX approvals_task ON approvals(task_id);
  `,
  // v2(フェーズ4): 設計の段で動かす役割。プランナーが判定し、計画の承認時に人が上書きできる
  `
  ALTER TABLE tasks ADD COLUMN design_architect INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN design_designer INTEGER NOT NULL DEFAULT 0;
  `,
  // v3(フェーズ5): 起動のつなぎ方。役目ごとの環境変数({ [role]: { KEY: "VALUE" } })
  `
  ALTER TABLE projects ADD COLUMN wiring_json TEXT;
  `,
  // v4(フェーズ5): 計画で決まった、変更するリポジトリの役目(実装する順。JSON の配列)。1リポジトリのプロジェクトでは null
  `
  ALTER TABLE tasks ADD COLUMN repos_json TEXT;
  `,
  // v5(フェーズ7): ツール全体の小さな状態(利用枠の最新の値など)。key ごとに JSON
  `
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v6(フェーズ7): リポジトリごとの、エージェントに読ませないパス(リポジトリのルートからの相対パス。JSON の配列)
  `
  ALTER TABLE repos ADD COLUMN protect_json TEXT;
  `,
  // v7(フェーズ8): プロジェクトの設定(小さなタスクの計画の自動承認、振り返りなど。JSON)
  `
  ALTER TABLE projects ADD COLUMN settings_json TEXT;
  `,
  // v8(フェーズ8): チケットの分割。子タスクの親と、子の順番(1から)
  `
  ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
  ALTER TABLE tasks ADD COLUMN seq INTEGER;
  `,
  // v9(フェーズ10): 進め方。fixed は固定の状態遷移、coordinator は LLM のコーディネーター(設計メモ v0.21)
  `
  ALTER TABLE tasks ADD COLUMN flow TEXT NOT NULL DEFAULT 'fixed';
  `,
  // v10(v0.25): 人のリポジトリで直接作業すると、タスクの作業場所がリポジトリのパスで重なるので、worktree_path の一意の制約を外す
  // (SQLite は制約だけを外せないので作り直す。worktree のパスはタスクの番号を含むので、worktree の方式では今も重ならない)
  `
  CREATE TABLE task_repos_v10 (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    worktree_path TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, repo_id)
  );
  INSERT INTO task_repos_v10 (task_id, repo_id, worktree_path, branch_name, base_sha, created_at)
    SELECT task_id, repo_id, worktree_path, branch_name, base_sha, created_at FROM task_repos;
  DROP TABLE task_repos;
  ALTER TABLE task_repos_v10 RENAME TO task_repos;
  `,
];
