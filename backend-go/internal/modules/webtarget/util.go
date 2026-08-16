package webtarget

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

// str renders a scalar the way the sidecar meant it; containers are not text
// and become empty rather than a Go dump.
func str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case map[string]any, []any:
		return ""
	}
	return fmt.Sprint(v)
}

func intPtr(v any) *int {
	switch t := v.(type) {
	case nil:
		return nil
	case bool:
		return nil
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		n := int(t)
		return &n
	case int:
		n := t
		return &n
	case string:
		if n, err := strconv.Atoi(t); err == nil {
			return &n
		}
	}
	return nil
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != "" && t != "false"
	case float64:
		return t != 0
	}
	return true
}

// pick returns the first key present in the map — the sidecar may report a
// field in snake_case or camelCase and both are accepted.
func pick(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, present := m[k]; present && v != nil {
			return v
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func containsInt(list []int, want int) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func jsonString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}
