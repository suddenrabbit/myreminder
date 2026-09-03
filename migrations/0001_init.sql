-- myreminder 初始表结构
-- 银行卡：借记卡仅用 银行/卡号；信用卡额外记录卡种类、卡组织、有效期、额度、账单日、还款日、权益、年费
CREATE TABLE IF NOT EXISTS bank_cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  card_type      TEXT    NOT NULL DEFAULT 'debit' CHECK (card_type IN ('debit', 'credit')),
  bank_key       TEXT    NOT NULL DEFAULT 'other',
  bank_name      TEXT    NOT NULL,
  color          TEXT    NOT NULL DEFAULT '#3b6bfa',
  card_number    TEXT    NOT NULL DEFAULT '',
  card_kind      TEXT    NOT NULL DEFAULT '',
  card_network   TEXT    NOT NULL DEFAULT '',
  expiry_date    TEXT    NOT NULL DEFAULT '',
  credit_limit   REAL,
  billing_day    INTEGER,
  repayment_day  INTEGER,
  benefits       TEXT    NOT NULL DEFAULT '',
  annual_fee     TEXT    NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bank_cards_order_idx ON bank_cards(sort_order, id);

-- 网站会员：网站名 / 到期日 / 边框色，按到期日自动排序
CREATE TABLE IF NOT EXISTS memberships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key     TEXT    NOT NULL DEFAULT 'other',
  site_name    TEXT    NOT NULL,
  color        TEXT    NOT NULL DEFAULT '#3b6bfa',
  expiry_date  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS memberships_expiry_idx ON memberships(expiry_date, id);
