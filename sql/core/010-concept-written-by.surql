-- 010: who wrote a concept, stamped server-side from the validated writing key.
--
-- NOTE: apply-schema.ts splits this file on the semicolon character BEFORE it
-- strips comment lines, so comments here MUST NOT contain a semicolon.
--
-- concept is SCHEMAFULL, so a field the table does not declare is silently
-- dropped on CREATE. written_by_key is the validated key's id and written_by is
-- the name identity answered for it. Both are set only by the concept write path
-- from the credential, never from the request. A concept written before this,
-- by a JWT session, or by a key identity gave no name for, holds NONE.
--
-- Idempotent (IF NOT EXISTS).

DEFINE FIELD IF NOT EXISTS written_by_key ON concept TYPE option<string>;

DEFINE FIELD IF NOT EXISTS written_by ON concept TYPE option<string>;
