-- ============================================================
-- Digital Girvi - Gold Loan / Pawn Management System
-- Database Schema
-- PostgreSQL
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE user_role AS ENUM ('admin', 'manager', 'staff');
CREATE TYPE loan_status AS ENUM ('active', 'closed', 'defaulted', 'auctioned', 'partial');
CREATE TYPE payment_type AS ENUM ('interest', 'principal', 'full_settlement', 'partial_settlement');
CREATE TYPE gold_purity AS ENUM ('24K', '22K', '20K', '18K', '16K', '14K');
CREATE TYPE item_type AS ENUM ('necklace', 'ring', 'bracelet', 'earring', 'bangle', 'chain', 'anklet', 'other');
CREATE TYPE transaction_type AS ENUM ('loan_disbursement', 'interest_payment', 'principal_payment', 'full_settlement', 'partial_settlement', 'auction_sale', 'fee_payment', 'penalty_payment');
CREATE TYPE notification_type AS ENUM ('overdue', 'due_soon', 'payment_received', 'loan_created', 'loan_closed', 'auction_notice');

-- ============================================================
-- USERS (Staff / Admin Accounts)
-- ============================================================

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username            VARCHAR(50) UNIQUE NOT NULL,
    email               VARCHAR(150) UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    full_name           VARCHAR(150) NOT NULL,
    role                user_role NOT NULL DEFAULT 'staff',
    phone               VARCHAR(20),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    totp_secret         TEXT,                          -- Encrypted TOTP secret (2FA)
    totp_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at       TIMESTAMPTZ,
    failed_login_count  INTEGER NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CUSTOMERS
-- ============================================================

CREATE TABLE customers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_code       VARCHAR(20) UNIQUE NOT NULL,  -- e.g. CUST-0001
    full_name           VARCHAR(150) NOT NULL,
    phone               VARCHAR(20) NOT NULL,
    alternate_phone     VARCHAR(20),
    email               VARCHAR(150),
    address_line1       TEXT NOT NULL,
    address_line2       TEXT,
    city                VARCHAR(100) NOT NULL,
    state               VARCHAR(100) NOT NULL,
    pincode             VARCHAR(10) NOT NULL,
    id_type             VARCHAR(50) NOT NULL,          -- Aadhaar, PAN, Voter ID, etc.
    id_number           TEXT NOT NULL,                 -- Stored encrypted
    id_number_masked    VARCHAR(20),                   -- e.g. XXXX-XXXX-1234
    date_of_birth       DATE,
    photo_url           TEXT,                          -- Customer photo path
    id_proof_url        TEXT,                          -- ID proof document path
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    notes               TEXT,
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- GOLD ITEMS (Pledged Items / Collateral)
-- ============================================================

CREATE TABLE gold_items (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id             UUID,                          -- Set after loan creation (FK added below)
    customer_id         UUID NOT NULL REFERENCES customers(id),
    item_type           item_type NOT NULL DEFAULT 'other',
    description         TEXT NOT NULL,                 -- e.g. "22K Gold Necklace with pendant"
    purity              gold_purity NOT NULL,
    gross_weight_grams  NUMERIC(8, 3) NOT NULL,        -- Total weight including stone/wax
    net_weight_grams    NUMERIC(8, 3) NOT NULL,        -- Pure gold weight
    stone_weight_grams  NUMERIC(8, 3) NOT NULL DEFAULT 0,
    appraised_value     NUMERIC(12, 2) NOT NULL,       -- Value at time of pledge
    gold_rate_at_pledge NUMERIC(10, 2) NOT NULL,       -- Gold rate (per gram) at pledge time
    item_photos         TEXT[],                        -- Array of photo paths
    appraisal_notes     TEXT,
    is_returned         BOOLEAN NOT NULL DEFAULT FALSE,
    returned_at         TIMESTAMPTZ,
    returned_by         UUID REFERENCES users(id),
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- LOANS
-- ============================================================

CREATE TABLE loans (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_number             VARCHAR(30) UNIQUE NOT NULL,   -- e.g. LN-2024-00001
    customer_id             UUID NOT NULL REFERENCES customers(id),
    principal_amount        NUMERIC(12, 2) NOT NULL,
    interest_rate           NUMERIC(5, 2) NOT NULL,        -- % per month
    loan_duration_months    INTEGER NOT NULL DEFAULT 12,
    start_date              DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date                DATE NOT NULL,
    closed_date             DATE,
    status                  loan_status NOT NULL DEFAULT 'active',
    total_gold_weight       NUMERIC(8, 3) NOT NULL,        -- Net gold weight (grams)
    gold_rate_at_pledge     NUMERIC(10, 2) NOT NULL,
    appraised_value         NUMERIC(12, 2) NOT NULL,       -- Total appraised value of pledged items
    ltv_percent             NUMERIC(5, 2),                 -- Loan-to-Value ratio
    interest_accrued        NUMERIC(12, 2) NOT NULL DEFAULT 0,
    interest_paid           NUMERIC(12, 2) NOT NULL DEFAULT 0,
    principal_paid          NUMERIC(12, 2) NOT NULL DEFAULT 0,
    penalty_amount          NUMERIC(12, 2) NOT NULL DEFAULT 0,
    penalty_paid            NUMERIC(12, 2) NOT NULL DEFAULT 0,
    processing_fee          NUMERIC(10, 2) NOT NULL DEFAULT 0,
    processing_fee_paid     BOOLEAN NOT NULL DEFAULT FALSE,
    renewal_count           INTEGER NOT NULL DEFAULT 0,
    parent_loan_id          UUID REFERENCES loans(id),     -- For renewals
    notes                   TEXT,
    created_by              UUID REFERENCES users(id),
    closed_by               UUID REFERENCES users(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add FK from gold_items to loans
ALTER TABLE gold_items ADD CONSTRAINT fk_gold_items_loan
    FOREIGN KEY (loan_id) REFERENCES loans(id);

-- ============================================================
-- PAYMENTS / TRANSACTIONS
-- ============================================================

CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_number      VARCHAR(30) UNIQUE NOT NULL,   -- e.g. PAY-2024-00001
    loan_id             UUID NOT NULL REFERENCES loans(id),
    customer_id         UUID NOT NULL REFERENCES customers(id),
    payment_type        payment_type NOT NULL,
    transaction_type    transaction_type NOT NULL,
    amount              NUMERIC(12, 2) NOT NULL,
    interest_component  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    principal_component NUMERIC(12, 2) NOT NULL DEFAULT 0,
    penalty_component   NUMERIC(12, 2) NOT NULL DEFAULT 0,
    payment_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method      VARCHAR(50) NOT NULL DEFAULT 'cash',  -- cash, upi, bank_transfer, cheque
    reference_number    VARCHAR(100),                  -- UPI ref, cheque number, etc.
    received_by         UUID REFERENCES users(id),
    notes               TEXT,
    receipt_url         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INTEREST ACCRUAL LEDGER
-- ============================================================

CREATE TABLE interest_ledger (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id             UUID NOT NULL REFERENCES loans(id),
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,
    principal_balance   NUMERIC(12, 2) NOT NULL,
    interest_rate       NUMERIC(5, 2) NOT NULL,
    interest_amount     NUMERIC(12, 2) NOT NULL,
    is_paid             BOOLEAN NOT NULL DEFAULT FALSE,
    paid_via_payment_id UUID REFERENCES payments(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================

CREATE TABLE settings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key             VARCHAR(100) UNIQUE NOT NULL,
    value           TEXT NOT NULL,
    description     TEXT,
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- GOLD RATE HISTORY
-- ============================================================

CREATE TABLE gold_rates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rate_per_gram   NUMERIC(10, 2) NOT NULL,           -- 24K gold rate per gram (INR)
    effective_date  DATE NOT NULL,
    source          VARCHAR(100),
    entered_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(effective_date)
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================

CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,             -- e.g. CREATE_LOAN, UPDATE_CUSTOMER
    entity_type     VARCHAR(50),                       -- e.g. loan, customer, payment
    entity_id       UUID,
    old_values      JSONB,
    new_values      JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id         UUID REFERENCES loans(id),
    customer_id     UUID REFERENCES customers(id),
    type            notification_type NOT NULL,
    title           VARCHAR(200) NOT NULL,
    message         TEXT NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    is_sent         BOOLEAN NOT NULL DEFAULT FALSE,    -- SMS/Email sent flag
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- REFRESH TOKENS (Auth)
-- ============================================================

CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Customers
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_customer_code ON customers(customer_code);
CREATE INDEX idx_customers_full_name ON customers(full_name);

-- Loans
CREATE INDEX idx_loans_customer_id ON loans(customer_id);
CREATE INDEX idx_loans_status ON loans(status);
CREATE INDEX idx_loans_due_date ON loans(due_date);
CREATE INDEX idx_loans_loan_number ON loans(loan_number);
CREATE INDEX idx_loans_created_at ON loans(created_at);

-- Gold Items
CREATE INDEX idx_gold_items_loan_id ON gold_items(loan_id);
CREATE INDEX idx_gold_items_customer_id ON gold_items(customer_id);

-- Payments
CREATE INDEX idx_payments_loan_id ON payments(loan_id);
CREATE INDEX idx_payments_customer_id ON payments(customer_id);
CREATE INDEX idx_payments_payment_date ON payments(payment_date);

-- Interest Ledger
CREATE INDEX idx_interest_ledger_loan_id ON interest_ledger(loan_id);
CREATE INDEX idx_interest_ledger_is_paid ON interest_ledger(is_paid);

-- Audit Logs
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- Notifications
CREATE INDEX idx_notifications_customer_id ON notifications(customer_id);
CREATE INDEX idx_notifications_loan_id ON notifications(loan_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);

-- Refresh Tokens
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- ============================================================
-- TRIGGERS: updated_at auto-update
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_loans_updated_at
    BEFORE UPDATE ON loans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_gold_items_updated_at
    BEFORE UPDATE ON gold_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SEED: Default System Settings
-- ============================================================

INSERT INTO settings (key, value, description) VALUES
    ('company_name',            'Digital Girvi',                    'Business name shown on receipts'),
    ('company_address',         '',                                  'Business address'),
    ('company_phone',           '',                                  'Business phone number'),
    ('company_gstin',           '',                                  'GST Identification Number'),
    ('default_interest_rate',   '2.00',                             'Default monthly interest rate (%)'),
    ('default_loan_duration',   '12',                               'Default loan duration in months'),
    ('default_processing_fee',  '0.00',                             'Default processing fee (INR)'),
    ('ltv_limit_percent',       '75.00',                            'Maximum Loan-to-Value ratio (%)'),
    ('overdue_penalty_rate',    '1.00',                             'Penalty interest rate per month after due date (%)'),
    ('currency_symbol',         '₹',                                'Currency symbol'),
    ('gold_purity_factor_24k',  '1.000',                            'Purity multiplier for 24K gold'),
    ('gold_purity_factor_22k',  '0.9167',                           'Purity multiplier for 22K gold'),
    ('gold_purity_factor_20k',  '0.8333',                           'Purity multiplier for 20K gold'),
    ('gold_purity_factor_18k',  '0.7500',                           'Purity multiplier for 18K gold'),
    ('gold_purity_factor_16k',  '0.6667',                           'Purity multiplier for 16K gold'),
    ('gold_purity_factor_14k',  '0.5833',                           'Purity multiplier for 14K gold'),
    ('due_soon_days',           '7',                                'Days before due date to trigger "due soon" notification'),
    ('sms_enabled',             'false',                            'Enable SMS notifications'),
    ('email_enabled',           'false',                            'Enable email notifications'),
    ('require_2fa',             'false',                            'Require 2FA for all staff logins');

-- ============================================================
-- SEED: Default Admin User
-- Password: Admin@123 (bcrypt hashed — change immediately after setup)
-- ============================================================

INSERT INTO users (username, email, password_hash, full_name, role) VALUES (
    'admin',
    'admin@digitalgirvi.local',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMlJbYbFe7T8/Nq7VpF5jPyXWi',
    'System Administrator',
    'admin'
);
