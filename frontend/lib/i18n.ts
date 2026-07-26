"use client";

import { useSyncExternalStore, useCallback } from "react";

export type Lang = "ar" | "en";

const LANG_KEY = "traceo_lang";

type Dict = Record<string, string>;

const ar: Dict = {
  // brand
  app_name: "Traceo",
  tagline: "requirement → test → result",
  logout: "تسجيل الخروج",
  login: "تسجيل الدخول",
  register: "إنشاء حساب",

  // actions
  save: "حفظ",
  cancel: "إلغاء",
  delete: "حذف",
  edit: "تعديل",
  approve: "اعتماد",
  approve_all: "اعتماد الكل",
  reject: "رفض",
  export: "تصدير",
  generate: "توليد",
  run: "تشغيل",
  create: "إنشاء",
  add: "إضافة",
  close: "إغلاق",
  confirm: "تأكيد",
  search: "بحث",
  upload: "رفع",
  download: "تنزيل",
  archive: "أرشفة",
  refresh: "تحديث",
  retry: "إعادة المحاولة",
  back: "رجوع",
  next: "التالي",
  previous: "السابق",
  loading: "جارٍ التحميل…",
  saving: "جارٍ الحفظ…",
  none: "—",

  // states
  draft: "مسودة",
  approved: "معتمد",
  rejected: "مرفوض",
  stale: "قديم",
  archived: "مؤرشف",
  extracted: "مستخرج",
  confirmed: "مؤكد",
  changed: "متغيّر",
  removed: "محذوف",
  passed: "ناجح",
  failed: "فاشل",
  errored: "خطأ",
  queued: "في الانتظار",
  running: "قيد التنفيذ",
  completed: "مكتمل",
  aborted: "مُجهض",
  cancelled: "ملغى",
  skipped: "متجاوز",

  // nav
  nav_dashboard: "نظرة عامة",
  nav_requirements: "المتطلبات",
  nav_endpoints: "الواجهات",
  nav_generate: "التوليد",
  nav_review: "المراجعة",
  nav_runs: "التشغيلات",
  nav_matrix: "مصفوفة التتبّع",
  nav_environments: "البيئات",
  nav_projects: "المشاريع",
  nav_members: "الأعضاء",
  nav_audit: "سجل التدقيق",
  nav_settings: "الإعدادات",

  // auth
  email: "البريد الإلكتروني",
  password: "كلمة المرور",
  name: "الاسم",
  org_name: "اسم المنشأة",
  no_account: "ليس لديك حساب؟",
  have_account: "لديك حساب بالفعل؟",
  demo_account: "حساب تجريبي",

  // common domain
  projects: "المشاريع",
  project: "المشروع",
  new_project: "مشروع جديد",
  project_name: "اسم المشروع",
  language: "اللغة",
  arabic: "العربية",
  english: "الإنجليزية",
  created_at: "تاريخ الإنشاء",
  requirements: "المتطلبات",
  requirement: "المتطلب",
  confirmed_requirements: "المؤكدة",
  test_cases: "حالات الاختبار",
  test_case: "حالة الاختبار",
  coverage: "التغطية",
  coverage_pct: "التغطية %",
  latest_run: "آخر تشغيل",
  no_runs_yet: "لا توجد تشغيلات بعد",
  quick_actions: "إجراءات سريعة",
  upload_document: "رفع مستند",
  pipeline: "خط المعالجة",
  pipe_analyze: "تحليل المتطلبات",
  pipe_discover: "اكتشاف الواجهات",
  pipe_generate: "التوليد المقيّد",
  pipe_review: "المراجعة البشرية",
  pipe_execute: "التنفيذ والتتبّع",
  total: "الإجمالي",
  duration: "المدة",
  state: "الحالة",
  type: "النوع",
  priority: "الأولوية",
  actions: "إجراءات",
  details: "التفاصيل",
  description: "الوصف",
  view: "عرض",

  // environments
  environments: "البيئات",
  environment: "البيئة",
  new_environment: "بيئة جديدة",
  env_name: "اسم البيئة",
  base_url: "الرابط الأساسي",
  auth_type: "نوع المصادقة",
  auth_none: "بدون",
  api_key: "مفتاح API",
  basic_auth: "أساسية (Basic)",
  bearer_token: "رمز Bearer",
  oauth2_cc: "OAuth2 Client Credentials",
  tls_verify: "تحقق TLS",
  tls_skip: "بدون تحقق TLS",
  secret_saved: "سر محفوظ",
  secret_hint: "تُحفظ الأسرار مشفّرة ولا تُعرض بعد الحفظ",
  check_connectivity: "فحص الاتصال",
  reachable: "قابل للوصول",
  unreachable: "غير قابل للوصول",
  header_name: "اسم الترويسة",
  key_value: "قيمة المفتاح",
  username: "اسم المستخدم",
  token: "الرمز",
  token_url: "رابط الرمز",
  client_id: "معرّف العميل",
  client_secret: "سر العميل",
  variables: "المتغيرات",

  // members / audit
  members: "الأعضاء",
  invite_member: "دعوة عضو",
  role: "الدور",
  remove: "إزالة",
  temp_password: "كلمة مرور مؤقتة",
  role_admin: "مدير",
  role_qa_lead: "قائد جودة",
  role_qa_engineer: "مهندس جودة",
  role_viewer: "مشاهد",
  audit_log: "سجل التدقيق",
  time: "الوقت",
  actor: "المنفّذ",
  action: "الإجراء",
  object: "الكائن",
  detail: "التفاصيل",

  // misc
  empty_title: "لا توجد بيانات",
  empty_hint: "لم يتم العثور على عناصر لعرضها",
  error_generic: "حدث خطأ غير متوقع",
  confirm_delete: "هل أنت متأكد من الحذف؟",
  optional: "اختياري",
  required: "مطلوب",
};

const en: Dict = {
  app_name: "Traceo",
  tagline: "requirement → test → result",
  logout: "Log out",
  login: "Log in",
  register: "Create account",

  save: "Save",
  cancel: "Cancel",
  delete: "Delete",
  edit: "Edit",
  approve: "Approve",
  approve_all: "Approve all",
  reject: "Reject",
  export: "Export",
  generate: "Generate",
  run: "Run",
  create: "Create",
  add: "Add",
  close: "Close",
  confirm: "Confirm",
  search: "Search",
  upload: "Upload",
  download: "Download",
  archive: "Archive",
  refresh: "Refresh",
  retry: "Retry",
  back: "Back",
  next: "Next",
  previous: "Previous",
  loading: "Loading…",
  saving: "Saving…",
  none: "—",

  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  stale: "Stale",
  archived: "Archived",
  extracted: "Extracted",
  confirmed: "Confirmed",
  changed: "Changed",
  removed: "Removed",
  passed: "Passed",
  failed: "Failed",
  errored: "Errored",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  aborted: "Aborted",
  cancelled: "Cancelled",
  skipped: "Skipped",

  nav_dashboard: "Overview",
  nav_requirements: "Requirements",
  nav_endpoints: "Endpoints",
  nav_generate: "Generate",
  nav_review: "Review",
  nav_runs: "Runs",
  nav_matrix: "Traceability Matrix",
  nav_environments: "Environments",
  nav_projects: "Projects",
  nav_members: "Members",
  nav_audit: "Audit log",
  nav_settings: "Settings",

  email: "Email",
  password: "Password",
  name: "Name",
  org_name: "Organisation name",
  no_account: "Don't have an account?",
  have_account: "Already have an account?",
  demo_account: "Demo account",

  projects: "Projects",
  project: "Project",
  new_project: "New project",
  project_name: "Project name",
  language: "Language",
  arabic: "Arabic",
  english: "English",
  created_at: "Created",
  requirements: "Requirements",
  requirement: "Requirement",
  confirmed_requirements: "Confirmed",
  test_cases: "Test cases",
  test_case: "Test case",
  coverage: "Coverage",
  coverage_pct: "Coverage %",
  latest_run: "Latest run",
  no_runs_yet: "No runs yet",
  quick_actions: "Quick actions",
  upload_document: "Upload document",
  pipeline: "Pipeline",
  pipe_analyze: "Requirements analysis",
  pipe_discover: "Endpoint discovery",
  pipe_generate: "Grounded generation",
  pipe_review: "Human review",
  pipe_execute: "Execution & traceability",
  total: "Total",
  duration: "Duration",
  state: "State",
  type: "Type",
  priority: "Priority",
  actions: "Actions",
  details: "Details",
  description: "Description",
  view: "View",

  environments: "Environments",
  environment: "Environment",
  new_environment: "New environment",
  env_name: "Environment name",
  base_url: "Base URL",
  auth_type: "Auth type",
  auth_none: "None",
  api_key: "API key",
  basic_auth: "Basic",
  bearer_token: "Bearer token",
  oauth2_cc: "OAuth2 Client Credentials",
  tls_verify: "TLS verify",
  tls_skip: "TLS skip",
  secret_saved: "Secret saved",
  secret_hint: "Secrets are stored encrypted and never shown after saving",
  check_connectivity: "Check connectivity",
  reachable: "Reachable",
  unreachable: "Unreachable",
  header_name: "Header name",
  key_value: "Key value",
  username: "Username",
  token: "Token",
  token_url: "Token URL",
  client_id: "Client ID",
  client_secret: "Client secret",
  variables: "Variables",

  members: "Members",
  invite_member: "Invite member",
  role: "Role",
  remove: "Remove",
  temp_password: "Temporary password",
  role_admin: "Admin",
  role_qa_lead: "QA Lead",
  role_qa_engineer: "QA Engineer",
  role_viewer: "Viewer",
  audit_log: "Audit log",
  time: "Time",
  actor: "Actor",
  action: "Action",
  object: "Object",
  detail: "Detail",

  empty_title: "Nothing here",
  empty_hint: "No items to display",
  error_generic: "Unexpected error",
  confirm_delete: "Are you sure you want to delete?",
  optional: "Optional",
  required: "Required",
};

const dicts: Record<Lang, Dict> = { ar, en };

// ---- module-level store (works across independently mounted client components) ----

let currentLang: Lang = "ar";
if (typeof window !== "undefined") {
  try {
    const stored = window.localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "ar") currentLang = stored;
  } catch {
    /* ignore */
  }
}

const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): Lang {
  return currentLang;
}

function getServerSnapshot(): Lang {
  return "ar";
}

export function applyDocumentLang(l: Lang): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = l;
  document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
}

function setLangGlobal(l: Lang): void {
  if (l !== "ar" && l !== "en") return;
  currentLang = l;
  try {
    window.localStorage.setItem(LANG_KEY, l);
  } catch {
    /* ignore */
  }
  applyDocumentLang(l);
  listeners.forEach((fn) => fn());
}

export function useLang(): { lang: Lang; setLang: (l: Lang) => void; dir: "rtl" | "ltr" } {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { lang, setLang: setLangGlobal, dir: lang === "ar" ? "rtl" : "ltr" };
}

/** Returns a translate function; returns the key itself when missing. */
export function useT(): (key: string) => string {
  const { lang } = useLang();
  return useCallback((key: string) => dicts[lang][key] ?? key, [lang]);
}

/** Non-hook translate for the current language (module snapshot). */
export function t(key: string): string {
  return dicts[currentLang][key] ?? key;
}
