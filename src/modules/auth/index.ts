export { AuthModule } from './auth.module';
export { AuthService } from './auth.service';
export type { LoginResult } from './auth.service';
export { TokenService } from './token.service';
export type { AccessTokenClaims, IssuedTokens, TokenContext } from './token.service';
export { PasswordHasherService } from './password/password-hasher.service';
export { CurrentUser } from './decorators/current-user.decorator';
export { JwtAuthGuard } from './guards/jwt-auth.guard';
export { mapLegacyRole, toAccountSlug, LEGACY_ROLE_NAMES } from './role-mapping';
export type { LegacyRoleName } from './role-mapping';
export { toLoginResponse, toUserView } from './dto/auth-response';
export type {
  AuthenticatedUserRecord,
  AuthenticatedUserView,
  LoginResponse,
} from './dto/auth-response';
export { LoginSchema, RefreshSchema, LogoutSchema } from './dto/auth.dto';
export type { LoginDto, RefreshDto, LogoutDto } from './dto/auth.dto';
