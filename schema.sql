-- D1 Database Schema for ChatGist
-- Tables are created safely with IF NOT EXISTS

CREATE TABLE IF NOT EXISTS Messages (
	id TEXT PRIMARY KEY,
	groupId TEXT,
	timeStamp INTEGER NOT NULL,
	userName TEXT,
	content TEXT,
	messageId INTEGER,
	groupName TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_groupid_timestamp
	ON Messages(groupId, timeStamp DESC);

CREATE TABLE IF NOT EXISTS WhitelistGroups (
	groupId TEXT PRIMARY KEY,
	groupName TEXT,
	addedBy TEXT,
	createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Admins (
	userId TEXT PRIMARY KEY,
	userName TEXT,
	addedBy TEXT,
	createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS UserUsage (
	userId TEXT NOT NULL,
	date TEXT NOT NULL,
	command TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (userId, date, command)
);
CREATE INDEX IF NOT EXISTS idx_userusage_date
	ON UserUsage(date);
