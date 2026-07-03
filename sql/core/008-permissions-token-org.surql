-- Rewrites table PERMISSIONS to $token.org_id per docs/RBAC_GUIDE.md -- comments in this file must never contain a semicolon because the apply-schema runner splits statements on semicolons before stripping comment lines

DEFINE TABLE OVERWRITE concept SCHEMAFULL PERMISSIONS FOR select WHERE (scope = 'global' AND public = true) OR org_id = $token.org_id FOR create, update WHERE org_id = $token.org_id FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

DEFINE TABLE OVERWRITE concept_edge SCHEMAFULL PERMISSIONS FOR select, create, update, delete WHERE org_id = $token.org_id;

DEFINE TABLE OVERWRITE concept_usage SCHEMAFULL PERMISSIONS FOR select, create WHERE org_id = $token.org_id FOR update, delete WHERE org_id = $token.org_id AND $token.role = 'admin';
