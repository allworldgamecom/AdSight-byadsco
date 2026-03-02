export interface InstagramAccount {
  id: string;
  name?: string;
  username?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
}

export const INSTAGRAM_ACCOUNT_FIELDS = [
  "id",
  "name",
  "username",
  "profile_picture_url",
  "followers_count",
  "media_count",
] as const;

export interface BoostEligibilityInfo {
  eligible_to_boost?: boolean;
  reason?: string;
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_url?: string;
  thumbnail_url?: string;
  timestamp?: string;
  permalink?: string;
  boost_eligibility_info?: BoostEligibilityInfo;
}

export const INSTAGRAM_MEDIA_DEFAULT_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_url",
  "thumbnail_url",
  "timestamp",
  "permalink",
  "boost_eligibility_info",
] as const;
