-- Up Migration
--
-- Refresh-token store. No legacy equivalent: the ASP.NET app used a 30-minute
-- sliding auth cookie with no server-side session record, so sessions could not
-- be revoked. Only the SHA-256 of each token is stored, so a database leak does
-- not yield usable tokens.

CREATE TABLE refresh_token (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    integer     NOT NULL REFERENCES user_logins(id) ON DELETE CASCADE,
    token_hash text        NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    user_agent text,
    ip         text
);

CREATE INDEX idx_refresh_token_user ON refresh_token(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_token_expiry ON refresh_token(expires_at) WHERE revoked_at IS NULL;

-- Housekeeping: revoked and expired rows are never read again. Schedule
--   DELETE FROM refresh_token WHERE expires_at < now() - interval '30 days';
-- as a periodic job.

-- Down Migration
DROP TABLE IF EXISTS refresh_token CASCADE;
