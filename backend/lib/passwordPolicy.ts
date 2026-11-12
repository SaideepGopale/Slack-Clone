/**
 * Password rules shared by every path where a person chooses a password
 * (T.32, audit M1/L25). The length minimum is the application's existing rule
 * (6, kept as a product decision — admin-created internal accounts rely on
 * it); what this adds is the same rule everywhere (password reset and change
 * previously accepted anything), a type check (non-strings used to reach
 * bcrypt and 500), and an upper bound in BYTES: bcrypt silently ignores
 * everything after 72 bytes, so a longer password would not mean what the
 * user thinks it means.
 */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_BYTES = 72;

/** Human-readable problem with a chosen password, or null when acceptable. */
export const passwordProblem = (value: unknown, minLength = PASSWORD_MIN_LENGTH): string | null => {
  if (typeof value !== 'string' || value.length === 0) return 'A password is required.';
  if (value.length < minLength) return `Password must be at least ${minLength} characters long.`;
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) return `Password must be at most ${PASSWORD_MAX_BYTES} bytes long.`;
  return null;
};

/**
 * The stronger rule for the first Company Admin (scripts/bootstrap-admin.ts):
 * at least 12 characters and three of lower/upper/digit/symbol.
 */
export const strongPasswordProblem = (value: unknown): string | null => {
  const basic = passwordProblem(value, 12);
  if (basic) return basic;
  const v = value as string;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  if (classes < 3) return 'Password must mix at least three of: lower-case, upper-case, digits, symbols.';
  return null;
};
