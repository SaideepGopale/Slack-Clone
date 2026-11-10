-- Stage 6B proposal (T.26, risk R2 of T.25): one account per e-mail address,
-- whatever its letter case. Hand-written: schema.prisma cannot express an
-- expression index, so it is documented there in a comment instead.
-- Login is unchanged (it still matches the stored address exactly); no
-- existing address is rewritten.

-- Fail fast instead of queueing every write to "User" behind this migration.
SET LOCAL lock_timeout = '5s';

-- Block writes to "User" (reads continue) from the check until the index
-- exists, so no case-variant row can slip in between the two.
LOCK TABLE "User" IN SHARE MODE;

-- Refuse with a count only, never an address, if existing rows already
-- collide (the plain index error would print the colliding address).
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
  FROM (SELECT 1 FROM "User" GROUP BY lower(email) HAVING count(*) > 1) AS d;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'User_email_lower_key: % e-mail address(es) are shared by accounts that differ only in letter case. Nothing was changed. Resolve them first (entireanalysis.md T.26).', collisions
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));
