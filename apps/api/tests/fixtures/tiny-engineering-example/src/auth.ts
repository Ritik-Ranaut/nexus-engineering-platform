export function verifyToken(token: string) {
  return jwt.verify(token, publicKey);
}

export function requireAuth(token: string) {
  try {
    return verifyToken(token);
  } catch (error) {
    if (error instanceof TokenExpiredError) throw new UnauthorizedError();
    throw error;
  }
}
