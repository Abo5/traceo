# كراسة الشروط

### المصادقة

REQ-001: يجب أن يتمكن العميل من تسجيل الدخول باستخدام رقم الجوال وكلمة المرور عبر الواجهة POST /auth/login.
- عند صحة البيانات تُعاد الاستجابة 200 مع رمز دخول access_token صالح للجلسة.
- عند خطأ رقم الجوال أو كلمة المرور تُعاد الاستجابة 401 دون إفشاء أيّ تفاصيل عن سبب الرفض.
- واجهة login هي الوحيدة التي لا تتطلب مصادقة مسبقة.

REQ-002: يجب أن يبدأ رقم الجوال بـ 05 وأن يتكوّن من 10 أرقام فقط.
- يُطبَّق النمط ^05[0-9]{8}$ على حقل phone عند إنشاء العميل عبر POST /customers وعند تسجيل الدخول.
- أي رقم مكوّن من 9 خانات أو 11 خانة يُرفض بالرمز 422 (invalid phone rejected).
- الرقم 0512345678 مثال على رقم صحيح مقبول.

REQ-003: يجب أن يكون البريد الإلكتروني للعميل بصيغة صحيحة.
- حقل email في إنشاء العميل customers يخضع للتحقق من الصيغة (email format).
- أي بريد لا يطابق الصيغة الصحيحة يُرفض بالرمز 422.

REQ-004: يجب أن يكون عمر العميل بين 18 و120 عاماً.
- قيمة age أقل من 18 تُرفض بالرمز 422 عند إنشاء العميل (customers age minimum).
- قيمة age أكبر من 120 تُرفض بالرمز 422 (age maximum).
- القيمتان 18 و120 مقبولتان لأن الحدود شاملة.

### الطلبات

REQ-005: يجب أن يحتوي الطلب الجديد على عنصر واحد على الأقل عند الإنشاء عبر POST /orders.
- قائمة items الفارغة تُرفض بالرمز 422 مع رمز الخطأ empty_items.
- كل عنصر يتضمن رمز الصنف sku والكمية qty.

REQ-006: يجب أن يكون إجمالي الطلب total أكبر من صفر عند إنشاء الطلب orders.
- القيمة صفر أو أي قيمة سالبة تُرفض بالرمز 422 (invalid total).
- تُقبل أي قيمة موجبة مثل 149.50.

REQ-007: يجب أن يُسمح بإلغاء الطلب قبل الشحن فقط عبر POST /orders/{id}/cancel.
- الطلب في حالة pending أو confirmed يُلغى بنجاح وتُعاد الاستجابة 200.
- الطلب المشحون dispatched أو المُسلَّم delivered يُرفض إلغاؤه بالرمز 409 (not cancellable).
- الطلب غير الموجود يُعاد له 404.

REQ-008: يجب أن تدعم قائمة الطلبات GET /orders الترشيح بحالة الطلب status.
- الحالات المسموحة: pending, confirmed, dispatched, delivered, cancelled.
- أي حالة أخرى غير معروفة تُرفض بالرمز 422 (invalid status).

REQ-009: يجب أن يبدأ ترقيم صفحات قائمة الطلبات orders من 1 عبر المعامل page.
- القيمة 0 أو أي قيمة سالبة للمعامل page تُرفض بالرمز 422 (invalid page).
- الاستجابة تتضمن الحقلين items و page.

### الفواتير

REQ-010: يجب أن تعرض الفاتورة عبر GET /invoices/{id} اسم العميل العربي بترميز سليم وباتجاه RTL.
- الحقل customer_name يُعاد بترميز UTF-8 دون تشويه للأحرف العربية.
- الحقل rendered_direction يكون rtl للفواتير العربية.
- الفاتورة غير الموجودة يُعاد لها 404.

REQ-011: يجب أن يتمكن الموظف المخوَّل من جلب بيانات عميل بمعرّفه عبر GET /customers/{id}.
- المعرّف الموجود يُعيد 200 مع بيانات العميل كاملة (id, name, phone, email, age).
- المعرّف غير الموجود يُعيد 404 (customer not found).

REQ-012: يجب أن تكون المصادقة برمز Bearer إلزامية على كل الواجهات عدا تسجيل الدخول /auth/login.
- واجهات customers و orders و invoices جميعها محمية وتتطلب ترويسة Authorization.
- يُستخدم رمز الدخول الصادر من واجهة login في جميع الطلبات اللاحقة.

### Annex (EN)

REQ-013: The system shall respond to any API request within 2 seconds under normal load.
- The 95th percentile response time for the customers and orders endpoints must not exceed 2000 ms.
- Response time is measured at the API gateway, excluding client network latency.

REQ-014: The system shall reject any unauthenticated request with HTTP 401.
- A request without a Bearer token to customers, orders or invoices returns 401 (unauthenticated).
- The 401 response body includes a machine-readable error code.
