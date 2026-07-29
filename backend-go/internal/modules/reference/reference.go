// Package reference — GET /reference/features: static feature catalog (v2 addendum),
// a verbatim port of backend/app/modules/reference.py. 37 features across 8
// capability groups; `status` reflects THIS codebase honestly: built = exercised by
// the running backend today, planned = referenced by the design but not implemented.
package reference

import (
	"github.com/gin-gonic/gin"

	"traceo/internal/httpx"
)

func f(id, group, nameAr, nameEn, priority, status, descriptionAr string) gin.H {
	return gin.H{"id": id, "group": group, "name_ar": nameAr, "name_en": nameEn,
		"priority": priority, "status": status, "description_ar": descriptionAr}
}

var groups = []gin.H{
	{"key": "parser", "name_en": "Layer 1 — Parser", "name_ar": "الطبقة 1 — المحلل"},
	{"key": "discovery", "name_en": "Layer 2 — Discovery", "name_ar": "الطبقة 2 — الاستكشاف"},
	{"key": "generator", "name_en": "Layer 3 — Generator", "name_ar": "الطبقة 3 — المولّد"},
	{"key": "execution", "name_en": "Layer 4 — Execution", "name_ar": "الطبقة 4 — التنفيذ"},
	{"key": "reporting", "name_en": "Layer 5 — Reporting", "name_ar": "الطبقة 5 — التقارير"},
	{"key": "automation", "name_en": "Automation", "name_ar": "الأتمتة"},
	{"key": "integrations", "name_en": "Integrations", "name_ar": "التكاملات"},
	{"key": "platform", "name_en": "Platform", "name_ar": "المنصة"},
}

var features = []gin.H{
	f("FR-010", "parser", "استيعاب المتطلبات", "Requirements ingestion",
		"P0", "built",
		"رفع مستند متطلبات PDF أو DOCX أو Markdown أو نصي ويستخرج ترايسو كل متطلب بمعرّف ووصف ونوع وأولوية مع إمكانية التصحيح قبل التوليد."),
	f("FR-011", "parser", "استيراد من Confluence", "Confluence import",
		"P1", "planned",
		"سحب صفحات المتطلبات من مساحة Confluence بدلاً من رفع ملف، مع اكتشاف الصفحات المتغيّرة عند إعادة الاستيراد."),
	f("FR-012", "parser", "تحليل المتطلبات العربية", "Arabic requirement parsing",
		"P0", "built",
		"تحليل وثائق RFP وBRD العربية بنفس دقة الإنجليزية، بما في ذلك النصوص ثنائية الاتجاه وتطبيع الأرقام الهندية (٠-٩)."),
	f("FR-013", "parser", "استخراج معايير القبول", "Acceptance-criteria extraction",
		"P0", "built",
		"تفكيك كل متطلب إلى معايير قبول ذرّية قابلة للاختبار تُبنى عليها الحالات ويُقاس عليها في المصفوفة."),
	f("FR-014", "parser", "التتبع إلى المصدر", "Source traceback",
		"P1", "built",
		"كل متطلب يحتفظ برابط إلى مستنده الأصلي والنص المصدري، ويظل التتبع صالحاً بعد إعادة تحليل نسخة محدّثة من المستند."),
	f("FR-020", "discovery", "اكتشاف OpenAPI", "OpenAPI discovery",
		"P0", "built",
		"قراءة نقاط النهاية والمعاملات والمخططات مباشرة من مواصفة OpenAPI 3.x أو Swagger 2.0 عبر الرفع أو الرابط، مع حلّ المراجع الداخلية بأمان."),
	f("FR-021", "discovery", "الاكتشاف عبر التقاط الحركة", "Traffic-capture discovery",
		"P0", "planned",
		"متصفح بلا واجهة يقود التطبيق ويبني خريطة النقاط من حركة الشبكة الملحوظة مع تحرير بيانات الاعتماد قبل التخزين."),
	f("FR-022", "discovery", "زحف DOM", "DOM crawl",
		"P1", "planned",
		"جمع النماذج والحقول وقواعد التحقق من جانب العميل من DOM المعروض لتغذية مدخلات الحدود والتكافؤ."),
	f("FR-023", "discovery", "استيراد Postman", "Postman import",
		"P2", "planned",
		"استيراد مجموعة Postman v2.1 قائمة ومعاملتها كسطح مكتشف مع تمييز مصدرها في خريطة التغطية."),
	f("FR-024", "discovery", "خريطة تغطية نقاط النهاية", "Endpoint coverage map",
		"P1", "built",
		"كل نقطة نهاية مكتشفة تعرض عدد الاختبارات التي تصيبها ونسبة المعاملات المغطاة وآخر نتيجة تنفيذ."),
	f("FR-030", "generator", "تحليل القيم الحدّية", "Boundary value analysis",
		"P0", "built",
		"توليد حالات للحد الأدنى والأقصى وما بعد كل حافة لكل حقل مقيّد رقمياً أو بالطول، انطلاقاً من مخطط المواصفة."),
	f("FR-031", "generator", "التقسيم بالتكافؤ", "Equivalence partitioning",
		"P0", "built",
		"حالة ممثلة واحدة لكل فئة صالحة وغير صالحة مشتقة من التعدادات والصيغ والقواعد المعلنة."),
	f("FR-032", "generator", "جداول القرار", "Decision tables",
		"P1", "built",
		"تعداد توليفات القواعد والشروط لمتطلبات قواعد العمل عند تفاعل قيدين أو أكثر (العمق الشامل)."),
	f("FR-033", "generator", "الحالات السلبية وحالات المصادقة", "Negative & auth cases",
		"P0", "built",
		"معامل مفقود، نوع خاطئ، جسم مشوّه، طلب بلا مصادقة على عملية مؤمّنة، وسلاسل بشكل حقن تُختبر بأمان."),
	f("FR-034", "generator", "فحوصات RTL والتوطين", "RTL / localisation checks",
		"P1", "built",
		"حمولات عربية واختبار ذهاب وإياب للترميز على الحقول النصية الحرة، تولَّد افتراضياً ضمن كل توليد."),
	f("FR-035", "generator", "التوليد المؤرّض", "Grounded generation",
		"P0", "built",
		"التوليد مقصور على النقاط المكتشفة؛ بوابة تأريض صارمة تتحقق من كل خطوة وتُسقط أي حالة تشير إلى نقطة أو حقل غير موجود — لا يتم إصلاحها أبداً."),
	f("FR-036", "generator", "مكتبة حالات الاختبار", "Test case library",
		"P1", "built",
		"كل الحالات المولّدة قابلة للتصفح والتصفية والتحرير؛ التعديلات اليدوية تُعلَّم وتشارك الحالات اليدوية في المصفوفة كالمولّدة."),
	f("FR-040", "execution", "محرك تنفيذ HTTP", "HTTP execution engine",
		"P0", "built",
		"تنفيذ الحالات المعتمدة ضد بيئة المشروع بتزامن قابل للضبط، مصادقة واحدة لكل تشغيل، وإلغاء أثناء التنفيذ مع الاحتفاظ بالنتائج الجزئية."),
	f("FR-041", "execution", "تأكيدات المخطط", "Schema assertions",
		"P0", "built",
		"التحقق من جسم الاستجابة مقابل مخطط الاستجابة المعلن في المواصفة، والمخالفة تُفشل الحالة حتى لو كان رمز الحالة صحيحاً."),
	f("FR-042", "execution", "تأكيدات قواعد العمل", "Business-rule assertions",
		"P0", "built",
		"تأكيدات مشتقة من معايير القبول لا من رموز الحالة فقط، ورسالة الفشل تعرض المتوقع والفعلي جنباً إلى جنب."),
	f("FR-043", "execution", "دورة حياة بيانات الاختبار", "Test data lifecycle",
		"P1", "planned",
		"تجهيز بيانات الاختبار قبل الحزمة وتفكيكها بعدها لكل تشغيل، مع الإبلاغ عن أي بيانات تعذّرت إزالتها."),
	f("FR-044", "execution", "التقاط الأداء", "Performance capture",
		"P2", "built",
		"تسجيل زمن الاستجابة لكل حالة وتقرير p50/p95/الأقصى لكل نقطة نهاية، مع تأكيد response_time_ms قادر على إفشال الحالة عند تجاوز الحد."),
	f("FR-050", "reporting", "مصفوفة التتبع", "Traceability matrix",
		"P0", "built",
		"متطلب ← حالات اختبار ← حكم، محدثة دائماً عند كل تشغيل وكل تغيير متطلب، وقابلة للتصدير XLSX."),
	f("FR-051", "reporting", "كشف فجوات التغطية", "Coverage gap detection",
		"P0", "built",
		"كل متطلب بلا حالة معتمدة يظهر كفجوة مع سبب واضح وإجراء تالٍ مقترح بالعربية."),
	f("FR-052", "reporting", "تقارير عيوب قابلة لإعادة الإنتاج", "Reproducible bug reports",
		"P0", "built",
		"خطوات مرقمة وسجل الطلب والاستجابة (بعد التحرير) والتأكيد الفاشل بالمتوقع والفعلي، مع شدة مشتقة من أولوية المتطلب وفئة الفشل."),
	f("FR-053", "reporting", "مقارنة التشغيلات", "Run comparison",
		"P1", "built",
		"مقارنة أي تشغيلين لنفس المشروع: الإخفاقات الجديدة، الإصلاحات، وفرق التغطية."),
	f("FR-054", "reporting", "اتجاه التغطية", "Coverage trend",
		"P1", "built",
		"رسم آخر 14 تشغيلاً مكتملاً بقيمة التغطية ونتائج كل تشغيل على لوحة المشروع."),
	f("FR-060", "automation", "التشغيلات المجدولة", "Scheduled runs",
		"P1", "built",
		"جدولة لكل مشروع وبيئة بفاصل زمني لا يقل عن 15 دقيقة؛ خيط مجدول يطلق نفس مسار التشغيل اليدوي ويظهر التشغيل في السجل بمصدر schedule."),
	f("FR-061", "automation", "بوابة CI/CD", "CI/CD gate",
		"P0", "built",
		"نقطة نهاية بوابة بمفاتيح API عامة: حد أدنى للتغطية وحد أقصى للعيوب الحرجة والإخفاقات؛ ‎?exit=1‎ تعيد 412 لإفشال خط الأنابيب مع تسمية المتطلبات المخالفة."),
	f("FR-062", "automation", "مراقبة الانحدار", "Regression watch",
		"P1", "built",
		"إبراز أي متطلب كان ناجحاً وبدأ يفشل على لوحة المشروع مع الحالة والشدة."),
	f("FR-070", "integrations", "تصدير Jira / Xray", "Jira / Xray export",
		"P0", "built",
		"تصدير نتائج التشغيل بصيغة استيراد Xray (xray.json) والإخفاقات كملف CSV جاهز للاستيراد في Jira مع الخطوات والشدة ومعرفات المتطلبات."),
	f("FR-071", "integrations", "تصدير التقارير PDF / XLSX", "PDF / XLSX report export",
		"P1", "built",
		"مصفوفة التتبع كملف XLSX بأوراق RTL للمشاريع العربية، وتقرير تشغيل HTML قابل للطباعة يؤدي دور PDF عبر طباعة المتصفح."),
	f("FR-072", "integrations", "إشعارات Slack", "Slack notifications",
		"P2", "built",
		"Webhooks عند اكتمال التشغيل بتوقيع HMAC، مع حالة خاصة لروابط Slack Incoming Webhook ترسل ملخصاً عربياً بعدّادات النتائج."),
	f("FR-080", "platform", "التحكم بالوصول حسب الدور", "Role-based access",
		"P1", "built",
		"أربعة أدوار (مدير، قائد جودة، مهندس جودة، مشاهد) تُفرض في الخادم عبر مصفوفة صلاحيات لكل نقطة نهاية."),
	// planned, not built: the stack runs offline (local SQLite, offline mock LLM
	// provider), but there is no deployment artefact yet — no container image, no
	// compose file, no upgrade path. Claiming "built" here would misrepresent the
	// product in the UI, since this catalog is shown to customers.
	f("FR-081", "platform", "النشر داخل الشبكة", "On-premise deployment",
		"P0", "planned",
		"المكوّنات تعمل دون اتصال بالإنترنت (SQLite محلي ومزوّد LLM محاكٍ)، لكن لا توجد بعد حزمة نشر: صورة حاوية، وملف تشكيل، ومسار ترقية."),
	f("FR-082", "platform", "سجل التدقيق", "Audit log",
		"P1", "built",
		"كل تغيير إعدادات وكل تشغيل يُسجل في سجل إلحاقي غير قابل للتعديل، مع تصدير كامل لبيانات المنشأة (PDPL)."),
	f("FR-083", "platform", "خزنة الأسرار", "Secrets vault",
		"P0", "built",
		"بيانات اعتماد النظام محل الاختبار مشفّرة عند السكون ولا تُكتب أبداً في السجلات أو التقارير أو الأدلة الملتقطة."),
}

func init() {
	if len(features) != 37 {
		panic("feature catalog must stay at 37 entries")
	}
}

func Register(r *gin.RouterGroup) {
	r.GET("/reference/features", httpx.Auth(), httpx.Require("view"), listFeatures)
}

func listFeatures(c *gin.Context) {
	built, planned := 0, 0
	for _, ft := range features {
		if ft["status"] == "built" {
			built++
		} else {
			planned++
		}
	}
	c.JSON(200, gin.H{"groups": groups, "features": features,
		"counts": gin.H{"total": len(features), "built": built, "planned": planned}})
}
