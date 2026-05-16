import mongoose, { Schema } from 'mongoose';
import { PLAN_TIERS, WORKSPACE_ROLES } from '../../shared/index.js';

export type AuthProviderId = 'google' | 'github' | 'linkedin' | 'microsoft';

export interface IUserAuthProvider {
  provider: AuthProviderId;
  providerId: string;
  email?: string;
  connectedAt: Date;
}

export interface IUser extends mongoose.Document {
  email: string;
  passwordHash?: string;
  firstName: string;
  // Optional — passwordless + social sign-ups may not have one. The
  // password-register path still enforces it via the zod schema.
  lastName?: string;
  avatarUrl?: string;
  providers?: IUserAuthProvider[];
  plan: (typeof PLAN_TIERS)[number];
  planExpiresAt?: Date;
  // Plan-granted credits. Resets on subscription renewal.
  monthlyCreditsBalance: number;
  // Top-up credits bought separately. Roll over forever.
  creditsBalance: number;
  // When the monthly bucket is next refilled. Set by subscribe /
  // renewIfDue. null when not on a plan (free users keep a monthly
  // grant too — see PLAN_CONFIG — so this is populated for them as well).
  subscriptionRenewsAt?: Date;
  workspaces: Array<{
    workspaceId: mongoose.Types.ObjectId;
    role: (typeof WORKSPACE_ROLES)[number];
  }>;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  paystackCustomerCode?: string;
  billingProvider?: 'stripe' | 'paystack';
  isEmailVerified: boolean;
  lastLoginAt?: Date;
  /**
   * Session epoch — bumped on logout / forced sign-out. Embedded in every
   * issued JWT (access + refresh) as the `tv` claim; the authenticate and
   * refresh paths reject any token whose `tv` doesn't match the current
   * value. A stolen cookie loses validity the moment the legitimate user
   * logs out (or admin force-rotates them) without us needing a denylist.
   */
  tokenVersion: number;
  /** First-run onboarding state (Task #19). Tracks completed steps so
   *  the wizard can resume mid-setup rather than re-show its intro.
   *  `dismissedAt` opts the user out entirely — we never re-prompt. */
  onboardingState?: {
    completedSteps: string[];
    dismissedAt?: Date;
    completedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Optional — social-only users never set a password.
    passwordHash: { type: String, select: false },
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, trim: true, maxlength: 100 },
    avatarUrl: { type: String },
    providers: [
      {
        provider: { type: String, enum: ['google', 'github', 'linkedin', 'microsoft'], required: true },
        providerId: { type: String, required: true },
        email: { type: String },
        connectedAt: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    plan: { type: String, enum: PLAN_TIERS, default: 'free' },
    planExpiresAt: { type: Date },
    monthlyCreditsBalance: { type: Number, default: 0, min: 0 },
    creditsBalance: { type: Number, default: 0, min: 0 },
    subscriptionRenewsAt: { type: Date },
    workspaces: [{
      workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace' },
      role: { type: String, enum: WORKSPACE_ROLES },
      _id: false,
    }],
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    paystackCustomerCode: { type: String },
    billingProvider: { type: String, enum: ['stripe', 'paystack'] },
    isEmailVerified: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
    tokenVersion: { type: Number, default: 0 },
    onboardingState: {
      completedSteps: { type: [String], default: [] },
      dismissedAt: { type: Date },
      completedAt: { type: Date },
    },
  },
  { timestamps: true }
);

userSchema.index({ 'workspaces.workspaceId': 1 });
// Fast provider-id lookup on OAuth callback. Partial + sparse so it's
// free for users who never connect a social provider.
userSchema.index(
  { 'providers.provider': 1, 'providers.providerId': 1 },
  { sparse: true },
);

export default mongoose.model<IUser>('User', userSchema);
