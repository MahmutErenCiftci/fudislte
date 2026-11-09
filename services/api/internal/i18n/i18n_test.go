package i18n

import (
	"regexp"
	"testing"
)

func TestFromAcceptLanguage(t *testing.T) {
	for header, want := range map[string]Locale{
		"":                        Turkish,
		"en-US,en;q=0.9":          English,
		"tr-TR,tr;q=0.9,en;q=0.8": Turkish,
		"de-DE, en-GB;q=0.7":      English,
		"fr-FR":                   Turkish,
		"EN":                      English,
	} {
		if got := FromAcceptLanguage(header, Turkish); got != want {
			t.Errorf("FromAcceptLanguage(%q) = %q, want %q", header, got, want)
		}
	}
}

func TestTranslateFallsBackToEnglish(t *testing.T) {
	if got := T(Turkish, "Not found."); got != "Bulunamadı." {
		t.Fatalf("got %q", got)
	}
	if got := T(English, "Not found."); got != "Not found." {
		t.Fatalf("got %q", got)
	}
	if got := T(Turkish, "An untranslated message."); got != "An untranslated message." {
		t.Fatalf("got %q", got)
	}
}

var verbs = regexp.MustCompile(`%[a-z]`)

// Translations must keep the same formatting verbs in the same order as the source.
func TestTurkishCatalogKeepsVerbs(t *testing.T) {
	for src, tr := range turkish {
		if a, b := verbs.FindAllString(src, -1), verbs.FindAllString(tr, -1); len(a) != len(b) {
			t.Errorf("verbs differ for %q: %v vs %v", src, a, b)
		} else {
			for i := range a {
				if a[i] != b[i] {
					t.Errorf("verb order differs for %q", src)
				}
			}
		}
		if tr == "" {
			t.Errorf("empty translation for %q", src)
		}
	}
}
