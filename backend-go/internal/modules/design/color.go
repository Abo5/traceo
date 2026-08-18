// Package design — deterministic extraction of what a rendered screen STATES:
// its palette and the role of each colour, the boxes its elements occupy, the
// edges they share, the spacing rhythm, and the exact WCAG contrast of every
// real ink. Port of backend/app/modules/design.py + the colour half of
// backend/app/modules/visual.py.
//
// Nothing here compares pixels. Two rasterizers disagree on ~25% of the pixels
// of an IDENTICAL antialiased edge, so a pixel score is a measurement of that
// noise. What survives rasterisation unchanged is flat colour and the structure
// it makes, and that is what this package measures — in integer arithmetic, so
// the same screenshot always yields the same facts.
package design

import "math"

// RGB is one 8-bit sRGB colour.
type RGB [3]int

// Lab is CIE L*a*b* under the D65 white point sRGB is defined against.
type Lab [3]float64

var d65 = [3]float64{0.95047, 1.00000, 1.08883}

const (
	labEps   = 216.0 / 24389.0 // (6/29)^3, the CIE constants in exact rational form
	labKappa = 24389.0 / 27.0  // (29/3)^3
)

// linearize converts an 8-bit sRGB channel to linear light (IEC 61966-2-1).
func linearize(channel int) float64 {
	c := float64(channel) / 255.0
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func srgbToXYZ(c RGB) (float64, float64, float64) {
	rl, gl, bl := linearize(c[0]), linearize(c[1]), linearize(c[2])
	return 0.4124564*rl + 0.3575761*gl + 0.1804375*bl,
		0.2126729*rl + 0.7151522*gl + 0.0721750*bl,
		0.0193339*rl + 0.1191920*gl + 0.9503041*bl
}

func labF(t float64) float64 {
	if t > labEps {
		return math.Cbrt(t)
	}
	return (labKappa*t + 16.0) / 116.0
}

// SRGBToLab converts a colour to L*a*b*.
func SRGBToLab(c RGB) Lab {
	x, y, z := srgbToXYZ(c)
	fx, fy, fz := labF(x/d65[0]), labF(y/d65[1]), labF(z/d65[2])
	return Lab{116.0*fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)}
}

// LabToSRGB is the inverse of SRGBToLab, clamped to the 8-bit gamut.
func LabToSRGB(lab Lab) RGB {
	l, a, b := lab[0], lab[1], lab[2]
	fy := (l + 16.0) / 116.0
	fx := fy + a/500.0
	fz := fy - b/200.0
	inv := func(f float64) float64 {
		c := f * f * f
		if c > labEps {
			return c
		}
		return (116.0*f - 16.0) / labKappa
	}
	x := inv(fx) * d65[0]
	var y float64
	if l > labKappa*labEps {
		t := (l + 16.0) / 116.0
		y = t * t * t * d65[1]
	} else {
		y = l / labKappa * d65[1]
	}
	z := inv(fz) * d65[2]

	rl := 3.2404542*x - 1.5371385*y - 0.4985314*z
	gl := -0.9692660*x + 1.8760108*y + 0.0415560*z
	bl := 0.0556434*x - 0.2040259*y + 1.0572252*z
	encode := func(c float64) int {
		c = math.Max(0.0, math.Min(1.0, c))
		var s float64
		if c <= 0.0031308 {
			s = 12.92 * c
		} else {
			s = 1.055*math.Pow(c, 1.0/2.4) - 0.055
		}
		v := int(math.Round(s * 255))
		if v < 0 {
			return 0
		}
		if v > 255 {
			return 255
		}
		return v
	}
	return RGB{encode(rl), encode(gl), encode(bl)}
}

func deg(r float64) float64 { return r * 180.0 / math.Pi }
func rad(d float64) float64 { return d * math.Pi / 180.0 }

// DeltaE2000 is the CIE 142-2001 perceptual colour difference (kL=kC=kH=1).
func DeltaE2000(lab1, lab2 Lab) float64 {
	l1, a1, b1 := lab1[0], lab1[1], lab1[2]
	l2, a2, b2 := lab2[0], lab2[1], lab2[2]

	c1 := math.Hypot(a1, b1)
	c2 := math.Hypot(a2, b2)
	cBar := (c1 + c2) / 2.0
	cBar7 := math.Pow(cBar, 7)
	g := 0.5 * (1.0 - math.Sqrt(cBar7/(cBar7+math.Pow(25.0, 7))))

	a1p, a2p := (1.0+g)*a1, (1.0+g)*a2
	c1p, c2p := math.Hypot(a1p, b1), math.Hypot(a2p, b2)

	hue := func(ap, bp float64) float64 {
		if ap == 0.0 && bp == 0.0 {
			return 0.0
		}
		h := deg(math.Atan2(bp, ap))
		if h < 0.0 {
			return h + 360.0
		}
		return h
	}
	h1p, h2p := hue(a1p, b1), hue(a2p, b2)

	dlp := l2 - l1
	dcp := c2p - c1p

	var dhp float64
	switch {
	case c1p*c2p == 0.0:
		dhp = 0.0
	case math.Abs(h2p-h1p) <= 180.0:
		dhp = h2p - h1p
	case h2p-h1p > 180.0:
		dhp = h2p - h1p - 360.0
	default:
		dhp = h2p - h1p + 360.0
	}
	dHp := 2.0 * math.Sqrt(c1p*c2p) * math.Sin(rad(dhp)/2.0)

	lBarP := (l1 + l2) / 2.0
	cBarP := (c1p + c2p) / 2.0

	var hBarP float64
	switch {
	case c1p*c2p == 0.0:
		hBarP = h1p + h2p
	case math.Abs(h1p-h2p) <= 180.0:
		hBarP = (h1p + h2p) / 2.0
	case h1p+h2p < 360.0:
		hBarP = (h1p + h2p + 360.0) / 2.0
	default:
		hBarP = (h1p + h2p - 360.0) / 2.0
	}

	t := 1.0 -
		0.17*math.Cos(rad(hBarP-30.0)) +
		0.24*math.Cos(rad(2.0*hBarP)) +
		0.32*math.Cos(rad(3.0*hBarP+6.0)) -
		0.20*math.Cos(rad(4.0*hBarP-63.0))

	dTheta := 30.0 * math.Exp(-math.Pow((hBarP-275.0)/25.0, 2))
	cBarP7 := math.Pow(cBarP, 7)
	rc := 2.0 * math.Sqrt(cBarP7/(cBarP7+math.Pow(25.0, 7)))
	lb := (lBarP - 50.0) * (lBarP - 50.0)
	sl := 1.0 + (0.015*lb)/math.Sqrt(20.0+lb)
	sc := 1.0 + 0.045*cBarP
	sh := 1.0 + 0.015*cBarP*t
	rt := -math.Sin(rad(2.0*dTheta)) * rc

	return math.Sqrt(
		math.Pow(dlp/sl, 2) +
			math.Pow(dcp/sc, 2) +
			math.Pow(dHp/sh, 2) +
			rt*(dcp/sc)*(dHp/sh))
}

// RelativeLuminance is the WCAG 2.x luminance of a colour.
func RelativeLuminance(c RGB) float64 {
	return 0.2126*linearize(c[0]) + 0.7152*linearize(c[1]) + 0.0722*linearize(c[2])
}

// ContrastRatio is the exact WCAG 2.x ratio between two colours.
func ContrastRatio(fg, bg RGB) float64 {
	l1, l2 := RelativeLuminance(fg), RelativeLuminance(bg)
	hi, lo := math.Max(l1, l2), math.Min(l1, l2)
	return (hi + 0.05) / (lo + 0.05)
}

// Hex renders a colour as #RRGGBB.
func (c RGB) Hex() string {
	const digits = "0123456789ABCDEF"
	out := []byte("#000000")
	for i, v := range c {
		if v < 0 {
			v = 0
		}
		if v > 255 {
			v = 255
		}
		out[1+i*2] = digits[v>>4]
		out[2+i*2] = digits[v&0x0F]
	}
	return string(out)
}

// Remedy is the closest passing colour to an ink that fails on its surface.
type Remedy struct {
	Original   RGB
	Surface    RGB
	Suggested  RGB
	Before     float64
	After      float64
	DeltaE     float64
	Target     float64
	Achievable bool // false when even black or white cannot reach the target
}

// NearestAccessible returns the closest colour to ink that reaches target
// contrast on surface.
//
// Only L* moves: a* and b* are the designer's hue and chroma decision and are
// left alone, so the suggestion is recognisably the same colour rather than a
// different one that happens to pass. Returned unchanged when it already
// passes, and flagged unachievable when even pure black or white falls short —
// which means the SURFACE has to change, not the text.
func NearestAccessible(ink, surface RGB, target float64) Remedy {
	before := ContrastRatio(ink, surface)
	if before >= target {
		return Remedy{ink, surface, ink, before, before, 0, target, true}
	}
	lab := SRGBToLab(ink)
	l0, a0, b0 := lab[0], lab[1], lab[2]
	darker := RelativeLuminance(surface) > RelativeLuminance(ink) ||
		RelativeLuminance(surface) > 0.5

	lo, hi := l0, 100.0
	if darker {
		lo, hi = 0.0, l0
	}
	extremeL := hi
	if darker {
		extremeL = lo
	}
	extreme := LabToSRGB(Lab{extremeL, a0, b0})
	if ContrastRatio(extreme, surface) < target {
		return Remedy{ink, surface, extreme, before, ContrastRatio(extreme, surface),
			DeltaE2000(SRGBToLab(ink), SRGBToLab(extreme)), target, false}
	}

	// Contrast is monotone in L* on either side of the surface, so bisection
	// converges on the least perceptual change that clears the bar.
	best := extreme
	for i := 0; i < 40; i++ {
		mid := (lo + hi) / 2.0
		cand := LabToSRGB(Lab{mid, a0, b0})
		if ContrastRatio(cand, surface) >= target {
			best = cand
			if darker {
				lo = mid
			} else {
				hi = mid
			}
		} else {
			if darker {
				hi = mid
			} else {
				lo = mid
			}
		}
	}
	return Remedy{ink, surface, best, before, ContrastRatio(best, surface),
		DeltaE2000(SRGBToLab(ink), SRGBToLab(best)), target, true}
}

// mix composites b over a at opacity t in LINEAR light — how a renderer blends.
func mix(a, b RGB, t float64) RGB {
	var out RGB
	for i := 0; i < 3; i++ {
		lin := linearize(a[i])*(1.0-t) + linearize(b[i])*t
		lin = math.Max(0.0, math.Min(1.0, lin))
		var s float64
		if lin <= 0.0031308 {
			s = 12.92 * lin
		} else {
			s = 1.055*math.Pow(lin, 1.0/2.4) - 0.055
		}
		v := int(math.Round(s * 255))
		if v < 0 {
			v = 0
		}
		if v > 255 {
			v = 255
		}
		out[i] = v
	}
	return out
}

// IsBlend reports whether colour is just surface blended with one of the
// candidates — an antialiased glyph edge or a semi-transparent divider is the
// renderer mixing two colours the design DID choose, not a design decision.
// Reporting those as low-contrast text buries the real findings under dozens of
// fringes, which is how an accessibility report becomes unreadable and then
// ignored. Returns the candidate it blends towards, or ok=false.
func IsBlend(colour, surface RGB, candidates []RGB, tolerance float64, steps int) (RGB, bool) {
	if colour == surface {
		return surface, true
	}
	want := SRGBToLab(colour)
	for _, cand := range candidates {
		if cand == surface {
			continue
		}
		for i := 1; i < steps; i++ {
			t := float64(i) / float64(steps)
			if DeltaE2000(want, SRGBToLab(mix(surface, cand, t))) <= tolerance {
				return cand, true
			}
		}
	}
	return RGB{}, false
}
