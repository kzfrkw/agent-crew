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
];
