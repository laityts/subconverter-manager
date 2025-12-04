-- 创建健康检查结果表
CREATE TABLE IF NOT EXISTS health_check_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    beijing_time TEXT NOT NULL,
    results TEXT NOT NULL, -- JSON格式的检查结果
    available_backend TEXT,
    fastest_response_time INTEGER,
    backend_changed BOOLEAN,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建订阅转换请求结果表
CREATE TABLE IF NOT EXISTS request_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    client_ip TEXT,
    backend_url TEXT NOT NULL,
    backend_selection_time INTEGER NOT NULL,
    response_time INTEGER NOT NULL,
    status_code INTEGER,
    success BOOLEAN,
    timestamp TEXT NOT NULL,
    beijing_time TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建后端状态表（用于快速查询最新状态）
CREATE TABLE IF NOT EXISTS backend_status (
    backend_url TEXT PRIMARY KEY,
    healthy BOOLEAN,
    last_checked TEXT,
    weight INTEGER,
    failure_count INTEGER,
    request_count INTEGER,
    last_success TEXT,
    version TEXT,
    response_time INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建D1写入统计表
CREATE TABLE IF NOT EXISTS d1_write_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL, -- 'health_check', 'request_result', 'backend_status'
    record_count INTEGER,
    beijing_date TEXT NOT NULL, -- YYYY-MM-DD格式
    timestamp TEXT NOT NULL,
    beijing_time TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);