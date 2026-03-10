-- ============================================================
-- payment_orders 表：记录用户支付行为的完整生命周期
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_orders (
    transaction_id          TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL,
    amount                  NUMERIC(10,2) NOT NULL,
    credits_amount          INTEGER NOT NULL DEFAULT 0,
    payment_status          TEXT NOT NULL DEFAULT 'pending'
                            CHECK (payment_status IN ('pending', 'completed', 'failed', 'expired')),
    payment_provider        TEXT NOT NULL
                            CHECK (payment_provider IN ('alipay', 'wxpay')),
    provider_transaction_id TEXT,
    credits_added           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  payment_orders IS '支付订单表 —— 记录、还原用户的支付行为';
COMMENT ON COLUMN payment_orders.transaction_id          IS '订单号，格式 TG_{userId}_{timestamp}_{random}';
COMMENT ON COLUMN payment_orders.user_id                 IS 'Telegram chatId';
COMMENT ON COLUMN payment_orders.amount                  IS '实际支付金额（人民币）';
COMMENT ON COLUMN payment_orders.credits_amount          IS '对应充入的星尘数';
COMMENT ON COLUMN payment_orders.payment_status          IS '订单状态：pending=待支付 | completed=已支付 | failed=支付失败 | expired=超时关闭';
COMMENT ON COLUMN payment_orders.payment_provider        IS '支付渠道：alipay=支付宝 | wxpay=微信支付';
COMMENT ON COLUMN payment_orders.provider_transaction_id IS '渠道侧流水号（JL trade_no），用于对账';
COMMENT ON COLUMN payment_orders.credits_added           IS '积分是否已成功到账（true=已入账, false=未入账）';
COMMENT ON COLUMN payment_orders.created_at              IS '订单创建时间';

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status  ON payment_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_created  ON payment_orders(created_at);

-- RLS（如果启用了 Row Level Security，按需调整）
-- ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
