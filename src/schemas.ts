// Response shapes (snake_case, ISO 8601 UTC dates, UUID strings). They document the API as OpenAPI components
// and are enforced when responses are serialised.
import { z } from 'zod';
import { SHAPES } from './categories.js';
import { CRITERIA } from './domain.js';

const criterionKey = z.enum(CRITERIA.map((c) => c.key) as ['vibe', 'offer', 'service', 'value']);
const isoDate = z.string().meta({ format: 'date-time' });
const score = z.number().int().min(1).max(5);
const category = z.string().meta({ description: 'A category id; `category_details` in GET /meta describes it' });
const calendarDate = z.string().meta({ format: 'date', example: '2026-10-12' });
const nextCursor = z.string().nullable().meta({ description: 'Pass as `cursor` for the next page; null at the end' });

export const ErrorBody = z
  .object({
    error: z.string().meta({ description: 'Machine-readable code, e.g. `not_authorized`, `invalid_input`' }),
    message: z.string().meta({ description: 'For logs and developers, not for display' }),
  })
  .loose()
  .meta({ id: 'Error' });

export const Profile = z
  .object({
    id: z.uuid(),
    display_name: z.string(),
    badge: z.string().nullable(),
    role: z.enum(['member', 'admin']),
    status: z.enum(['active', 'suspended', 'deleted']),
    favorite_categories: z.array(category),
    avatar_url: z.string().nullable().meta({ description: 'Signed URL of the own avatar, else the Google picture' }),
    created_at: isoDate,
  })
  .meta({ id: 'Profile', description: 'A member as others see them.' });

export const GoldStarQuota = z
  .object({
    per_month: z.number().int(),
    left: z.number().int(),
    month: z.string().meta({ description: 'First day of the current month (Europe/Warsaw), YYYY-MM-DD' }),
  })
  .meta({ id: 'GoldStarQuota' });

export const NotificationPrefs = z
  .object({
    new_places: z.enum(['all', 'favorites', 'none']).meta({
      description: 'New places: all of them, only in my favourite categories (default), or none',
    }),
    comments: z.boolean().meta({ description: 'Comments on places I added, commented on or saved' }),
  })
  .meta({ id: 'NotificationPrefs', description: 'What push notifications I get.' });

export const Me = Profile.extend({
  email: z.string(),
  notifications: NotificationPrefs,
  is_admin: z.boolean().meta({ description: 'Can use the /admin endpoints (the admin dashboard of the web app)' }),
  has_profile: z.boolean().meta({ description: 'false until POST /me/profile; the app shows onboarding' }),
  gold_stars: GoldStarQuota,
}).meta({ id: 'Me', description: 'The signed-in member.' });

export const Session = z
  .object({ token: z.string(), expires_at: isoDate, has_profile: z.boolean(), user: Me })
  .meta({ id: 'Session', description: 'Send the token as `Authorization: Bearer <token>`.' });

export const PhotoFile = z
  .object({
    id: z.uuid(),
    url: z.string().meta({ description: 'Signed, valid 12–24 h' }),
    thumb_url: z.string().meta({ description: `Signed 400 px JPEG` }),
    blurhash: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
  })
  .meta({ id: 'Photo' });

export const Location = z.object({ lat: z.number(), lng: z.number() });

export const CARD_LAYOUTS = ['auto', 'a', 'b', 'c', 'diagonal', 'ribbon', 'arch', 'wedge'] as const;
export const PHOTO_FILTERS = [
  'none',
  'duotone',
  'halftone',
  'engraving',
  'riso',
  'xerox',
  'hatch',
  'mosaic',
  'sunset',
] as const;
/** The app's card colours (design tokens `cardColor` in the app repo). */
export const CARD_COLORS = [
  'red',
  'blue',
  'yellow',
  'ink',
  'orange',
  'pink',
  'green',
  'teal',
  'sky',
  'navy',
  'violet',
  'ochre',
  'brick',
  'olive',
  'sand',
  'stone',
] as const;

export const CardStyle = z
  .object({
    layout: z.enum(CARD_LAYOUTS).meta({
      description:
        'List card: a = photo full width, b = poster without photo, c = photo in a circle, ' +
        'diagonal = photo cut by a coloured triangle, ribbon = poster with a diagonal band, arch = photo in an arch, ' +
        'wedge = photo in a parallelogram; auto = app rotates a, b, c',
    }),
    photo_filter: z.enum(PHOTO_FILTERS).meta({ description: 'Filter on the list card and the main photo' }),
    filter_intensity: z.number().int().min(0).max(100).meta({ description: 'Filter strength in percent' }),
    color: z.enum(CARD_COLORS).nullable().meta({ description: "The card's main colour; null = the category's colour" }),
  })
  .meta({ id: 'CardStyle', description: 'How the place is presented in the app, chosen by its author' });

export const PlaceSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    category_id: category,
    status: z.enum(['active', 'temporarily_closed', 'closed']),
    price_level: z.number().int().min(1).max(4).nullable(),
    address: z.string().nullable(),
    description: z.string().nullable(),
    location: Location,
    tags: z.array(z.string()),
    open_now: z.boolean().nullable().meta({ description: 'null when opening hours are unknown' }),
    rating_avg: z.number().nullable(),
    rating_count: z.number().int(),
    gold_star_count: z.number().int(),
    gold_stars_this_month: z.number().int(),
    comment_count: z.number().int(),
    rank_score: z.number(),
    cover_photo: PhotoFile.nullable(),
    distance_m: z.number().nullable().meta({ description: 'Only when lat/lng were given' }),
    author: Profile,
    my_rating: z.number().nullable().meta({ description: 'My overall rating, null if I have not rated it' }),
    is_saved: z.boolean(),
    card_style: CardStyle,
    created_at: isoDate,
    updated_at: isoDate,
  })
  .meta({ id: 'PlaceSummary' });

export const PlaceList = z
  .object({ items: z.array(PlaceSummary), next_cursor: nextCursor, total: z.number().int() })
  .meta({ id: 'PlaceList' });

export const OpeningPeriod = z
  .object({
    day: z.number().int().min(0).max(6).meta({ description: '0 = Sunday … 6 = Saturday' }),
    open: z.string().meta({ example: '18:00' }),
    close: z.string().meta({ example: '02:00', description: 'Earlier than open = closes after midnight' }),
  })
  .meta({ id: 'OpeningPeriod' });

export const Scores = z.object({ vibe: score, offer: score, service: score.nullable(), value: score.nullable() }).meta({
  id: 'Scores',
  description: 'vibe = klimat, offer = oferta, service = obsługa, value = wartość; null = nie dotyczy',
});

export const Comment = z
  .object({
    id: z.uuid(),
    body: z.string(),
    author: Profile,
    author_rating: z.number().nullable().meta({ description: "The author's current overall rating of the place" }),
    is_mine: z.boolean(),
    created_at: isoDate,
    updated_at: isoDate.nullable(),
  })
  .meta({ id: 'Comment' });

export const PlaceDetail = PlaceSummary.extend({
  google_place_id: z.string().nullable(),
  google_maps_url: z.string().nullable().meta({ description: 'Opens this place in Google Maps' }),
  opening_hours: z.array(OpeningPeriod).nullable(),
  photos: z.array(PhotoFile.extend({ uploaded_by: z.uuid() })),
  criteria: z.array(z.object({ key: criterionKey, average: z.number().nullable(), count: z.number().int() })),
  strongest_criterion: criterionKey.nullable(),
  rating_distribution: z
    .object({ 1: z.number().int(), 2: z.number().int(), 3: z.number().int(), 4: z.number().int(), 5: z.number().int() })
    .meta({ description: 'Overall ratings rounded to whole stars' }),
  my_scores: Scores.nullable(),
  my_visited_on: calendarDate.nullable().meta({ description: 'When I was there (with my rating); null if not given' }),
  gold_star_awarders: z.array(Profile).meta({ description: 'Everyone who gave a gold star, newest first' }),
  my_gold_star: z.object({ awarded_at: isoDate }).nullable().meta({ description: 'My star this month' }),
  can_revoke_gold_star: z.boolean(),
  gold_stars_left: z.number().int(),
  comments: z.array(Comment).meta({ description: 'Oldest first' }),
  is_mine: z.boolean().meta({ description: 'I added this place' }),
}).meta({ id: 'PlaceDetail' });

export const MyRatingList = z
  .object({
    items: z.array(
      z.object({
        place: z.object({ id: z.uuid(), name: z.string(), category_id: category }),
        scores: Scores,
        overall: z.number(),
        visited_on: calendarDate.nullable().meta({ description: 'When I was there; null if not given' }),
        updated_at: isoDate,
      }),
    ),
    next_cursor: nextCursor,
    total: z.number().int(),
  })
  .meta({ id: 'MyRatingList' });

export const GoldStarResult = z
  .object({ awarded: z.boolean(), gold_stars_left: z.number().int() })
  .meta({ id: 'GoldStarResult' });
export const SavedResult = z.object({ is_saved: z.boolean() }).meta({ id: 'SavedResult' });

export const CommentList = z
  .object({ items: z.array(Comment), next_cursor: nextCursor, total: z.number().int() })
  .meta({ id: 'CommentList' });

const CategoryCount = z.object({ category_id: category, count: z.number().int() });

export const NetworkStats = z
  .object({
    members: z.number().int(),
    places: z.number().int(),
    ratings: z.number().int(),
    average_rating: z.number().nullable(),
    month: z.string(),
    gold_stars_this_month: z.number().int(),
    star_of_the_month: z.object({ place: PlaceSummary, stars: z.number().int() }).nullable(),
    top: z.array(PlaceSummary),
    categories: z.array(CategoryCount).meta({ description: 'Places per category, most first' }),
    weekly_activity: z
      .array(z.number().int())
      .meta({ description: 'Ratings per week for the last 12 weeks (Monday-based), oldest first' }),
  })
  .meta({ id: 'NetworkStats' });

export const MyStats = z
  .object({
    places_added: z.number().int(),
    ratings_given: z.number().int(),
    average_given: z.number().nullable(),
    distribution: z
      .object({
        1: z.number().int(),
        2: z.number().int(),
        3: z.number().int(),
        4: z.number().int(),
        5: z.number().int(),
      })
      .meta({ description: 'My overall ratings rounded to whole stars' }),
    categories: z.array(CategoryCount).meta({ description: 'Places I rated, per category, most first' }),
    taste_matches: z
      .array(z.object({ profile: Profile, match: z.number() }))
      .meta({ description: 'Top 3 members by taste match (0–1), from at least 3 places rated by both' }),
    my_places_with_stars: z
      .array(z.object({ place: PlaceSummary, stars: z.number().int() }))
      .meta({ description: 'Places I added that got gold stars, most first' }),
    comments: z.number().int(),
    saved: z.number().int(),
    gold_stars: z.object({ given_total: z.number().int(), given_this_month: z.number().int(), left: z.number().int() }),
  })
  .meta({ id: 'MyStats' });

export const CategoryIcon = z
  .object({
    id: z.string().meta({ description: 'Icon id in the library' }),
    path: z.string().meta({
      description:
        'SVG path data (`d`) on a 24×24 grid (`viewBox="0 0 24 24"`), filled with the even-odd rule in the ' +
        "category's colour (holes are separate subpaths). Commands M L H V C S Q T A Z, absolute or relative.",
    }),
  })
  .meta({ id: 'CategoryIcon', description: "A category's pictogram, managed by admins in the icon library." });

export const Category = z
  .object({
    id: z.string().meta({ description: 'Stable id, used as `category_id` everywhere' }),
    label: z.string().meta({ description: 'Polish name to show' }),
    color: z.string().meta({ description: 'Main colour, `#RRGGBB`' }),
    shape: z.enum(SHAPES).meta({
      description:
        'The category mark, drawn in `color` in a 44×44 box: `circle` (full circle), `half` (upper half disc ' +
        'sitting on the bottom edge), `triangle` (apex up), `triangle_down` (apex down), `ring` (circle in ' +
        '`color` with a 2 pt ink outline), `square`, `quarter` (quarter disc, square corner at bottom right), ' +
        '`house` (pentagon: square with a roof, eaves at 18/44). Drawn when the category has no icon.',
    }),
    icon: CategoryIcon.nullable().meta({ description: 'The pictogram; null — draw `shape`' }),
    position: z.number().int().meta({ description: 'Display order, ascending' }),
    active: z.boolean().meta({
      description: 'False when retired: existing places keep it (still draw it), but do not offer it for new ones',
    }),
  })
  .meta({ id: 'Category', description: 'A place category, managed by admins.' });

export const Meta = z
  .object({
    categories: z
      .array(category)
      .meta({ description: 'Ids of the active categories in display order (older clients; see category_details)' }),
    category_details: z
      .array(Category)
      .meta({ description: 'Every category, retired ones too, in display order. Cache it with the rest of /meta.' }),
    criteria: z.array(z.object({ key: criterionKey, label: z.string(), required: z.boolean() })),
    gold_stars_per_month: z.number().int(),
    max_photo_bytes: z.number().int(),
    max_photos_per_rating: z.number().int(),
    time_zone: z.string(),
    google_web_client_id: z
      .string()
      .nullable()
      .meta({ description: 'For Google sign-in on the web (web app and admin dashboard)' }),
    dev_login: z.boolean().meta({ description: 'Whether POST /auth/dev is available (never in production)' }),
  })
  .meta({ id: 'Meta' });

const Role = z.enum(['member', 'admin']);

export const AllowedEmail = z
  .object({
    email: z.string(),
    role: Role,
    note: z.string().nullable(),
    from_environment: z.boolean().meta({ description: 'Listed in ADMIN_EMAILS: cannot be removed or demoted here' }),
    added_by: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
    created_at: isoDate,
    user: z
      .object({
        id: z.uuid(),
        display_name: z.string(),
        avatar_url: z.string().nullable(),
        joined_at: isoDate,
        last_seen_at: isoDate,
        places: z.number().int(),
        ratings: z.number().int(),
      })
      .nullable()
      .meta({ description: 'null until the person signs in for the first time' }),
  })
  .meta({ id: 'AllowedEmail' });

export const AllowedEmailList = z
  .object({ items: z.array(AllowedEmail), admins: z.number().int(), members: z.number().int() })
  .meta({ id: 'AllowedEmailList' });

export const Setting = z
  .object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
    value: z.number(),
    default: z.number(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    integer: z.boolean(),
    updated_at: isoDate.nullable(),
    updated_by: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
  })
  .meta({ id: 'Setting' });

export const SettingList = z.object({ items: z.array(Setting) }).meta({ id: 'SettingList' });

export const AdminCategory = Category.extend({
  places: z.number().int().meta({ description: 'Places in this category' }),
  updated_at: isoDate,
  updated_by: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
}).meta({ id: 'AdminCategory' });

export const AdminIcon = CategoryIcon.extend({
  label: z.string().meta({ description: 'Polish name, e.g. in the icon picker' }),
  categories: z.number().int().meta({ description: 'Categories using this icon' }),
  updated_at: isoDate,
  updated_by: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
}).meta({ id: 'AdminIcon' });

export const AdminIconList = z.object({ items: z.array(AdminIcon) }).meta({ id: 'AdminIconList' });

export const AdminCategoryList = z.object({ items: z.array(AdminCategory) }).meta({ id: 'AdminCategoryList' });

export const Device = z
  .object({
    platform: z.enum(['ios', 'android']),
    environment: z.enum(['sandbox', 'production']),
    app_id: z.string().meta({ description: 'Bundle id / package name' }),
    created_at: isoDate,
    last_seen_at: isoDate,
  })
  .meta({ id: 'Device' });

export const PushCounts = z
  .object({
    recipients: z.number().int().meta({ description: 'People chosen' }),
    devices: z.number().int().meta({ description: 'Their devices' }),
    delivered: z.number().int().meta({ description: 'Accepted by APNs or FCM' }),
    failed: z.number().int().meta({ description: 'Not delivered (also every device when push is not configured)' }),
  })
  .meta({ id: 'PushCounts' });

export const PushSubscriber = z
  .object({
    profile: Profile,
    email: z.string(),
    notifications: NotificationPrefs,
    devices: z.array(Device),
  })
  .meta({ id: 'PushSubscriber', description: 'A member and the devices they get notifications on.' });

export const PushOverview = z
  .object({
    configured: z.boolean().meta({ description: 'APNs or FCM credentials are set; without them nothing is sent' }),
    members: z.array(PushSubscriber).meta({ description: 'Every active member, with or without devices' }),
  })
  .meta({ id: 'PushOverview' });

export const PushLogEntry = PushCounts.extend({
  id: z.uuid(),
  created_at: isoDate,
  kind: z.enum(['new_place', 'new_comment', 'admin']),
  title: z.string(),
  body: z.string(),
  place_id: z.uuid().nullable(),
  audience: z.record(z.string(), z.unknown()),
  sent_by: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
}).meta({ id: 'PushLogEntry' });

export const PushLog = z.object({ items: z.array(PushLogEntry) }).meta({ id: 'PushLog' });

export const TagList = z
  .object({
    items: z.array(
      z.object({
        tag: z.string().meta({ description: 'As most places spell it' }),
        places: z.number().int().meta({ description: 'Places with this tag' }),
        in_category: z.number().int().meta({ description: 'Of them, places in `category` (0 without it)' }),
      }),
    ),
  })
  .meta({ id: 'TagList' });

export const ResolvedMapsLink = z
  .object({
    url: z.string().meta({ description: 'The link to store as `google_maps_url` (short links as pasted)' }),
    name: z.string().nullable().meta({ description: "The place's name on Google Maps, if the link names one" }),
    location: z
      .object({
        lat: z.number(),
        lng: z.number(),
        precise: z.boolean().meta({ description: "False: the map view's centre, near the place but not on it" }),
      })
      .nullable(),
    nearby: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          category_id: z.string(),
          distance_m: z.number(),
        }),
      )
      .meta({ description: 'Places already in the app within 150 m, likeliest duplicates first' }),
  })
  .meta({ id: 'ResolvedMapsLink' });

export const WishlistItem = z
  .object({
    id: z.uuid(),
    name: z.string(),
    lat: z.number(),
    lng: z.number(),
    address: z.string().nullable(),
    description: z.string().nullable(),
    url: z.string().nullable().meta({ description: 'A link with more (website, Google Maps, article)' }),
    visited_on: calendarDate.nullable().meta({ description: 'Set once the owner has been there' }),
    place_id: z.uuid().nullable().meta({ description: 'The regular place it was added as after the visit' }),
    owner: Profile,
    is_mine: z.boolean(),
    created_at: isoDate,
    updated_at: isoDate.nullable(),
  })
  .meta({ id: 'WishlistItem', description: 'A place someone wants to visit — no category, ratings or photos' });

export const WishlistItemList = z
  .object({ items: z.array(WishlistItem), next_cursor: nextCursor, total: z.number().int() })
  .meta({ id: 'WishlistItemList' });

const ReportChoice = z
  .object({ id: z.string(), label: z.string().meta({ description: 'In the project’s language, as set in PMO' }) })
  .meta({ id: 'ReportChoice' });

export const ReportOptions = z
  .object({
    issue_types: z.array(ReportChoice).meta({ description: 'Types to offer, in order (e.g. bug, idea, abuse)' }),
    platforms: z.array(ReportChoice).meta({ description: 'Platforms to offer, e.g. web, android, ios' }),
  })
  .meta({ id: 'ReportOptions', description: 'What the report form offers, configured in the issue tracker (PMO).' });

export const Report = z
  .object({
    key: z.string().meta({ example: 'DM-12' }),
    type: z.string().meta({ description: 'An id from `issue_types` in GET /reports/options' }),
    status: z.string().meta({
      description:
        'As tracked in PMO: `reported`, `accepted`, `in_progress`, `in_review`, `waiting_for_release`, `done`, ' +
        '`wont_fix` or `duplicate`. Not a closed list: PMO may add statuses, so show unknown ones as they are.',
    }),
    priority: z.string().meta({ description: 'P1 (most urgent) to P5, set by the admins' }),
    title: z.string(),
    description: z.string().nullable(),
    platform: z.string().nullable().meta({ description: 'An id from `platforms` in GET /reports/options' }),
    private: z.boolean().meta({ description: 'Only the admins and the reporter see it (abuse reports)' }),
    duplicate_of: z.string().nullable().meta({ description: 'Key of the original report, when a duplicate' }),
    comment_count: z.number().int().default(0).meta({ description: 'Comments to show (GET /reports/{key}/comments)' }),
    created_at: isoDate,
    updated_at: isoDate,
  })
  .meta({ id: 'Report', description: 'A bug report, idea or abuse report, as tracked in PMO.' });

export const ReportComment = z
  .object({
    id: z.string(),
    body: z.string(),
    author: z.string().nullable().meta({ description: 'Who wrote it, e.g. an admin; null if unknown' }),
    created_at: isoDate,
  })
  .meta({ id: 'ReportComment', description: 'A comment on a report, e.g. why it won’t be fixed.' });

export const ReportCommentList = z.object({ items: z.array(ReportComment) }).meta({ id: 'ReportCommentList' });

export const CreatedReport = Report.extend({
  attachments: z.number().int().meta({ description: 'Files attached' }),
  failed_files: z.array(z.string()).meta({ description: 'Names of files the tracker did not accept' }),
}).meta({ id: 'CreatedReport' });

export const ReportList = z
  .object({
    items: z.array(Report),
    next_offset: z
      .number()
      .int()
      .nullable()
      .meta({ description: 'Pass as `offset` for the next page; null at the end' }),
  })
  .meta({ id: 'ReportList' });
