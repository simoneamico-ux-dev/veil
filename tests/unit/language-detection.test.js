import { describe, it, expect, vi } from 'vitest';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import {
  detectLanguageFromText,
  getNavigatorLanguage,
  TESSERACT_LANGUAGE_CODES,
} from '../../core.js';

describe('Tesseract language assets', () => {
  it('includes a local model for every selectable language', () => {
    const modelDirectory = resolve('vendor/tesseract-data/4.0.0_best_int');
    const shippedLanguages = readdirSync(modelDirectory)
      .filter(name => name.endsWith('.traineddata.gz'))
      .map(name => name.replace('.traineddata.gz', ''))
      .sort();

    expect(shippedLanguages).toEqual([...TESSERACT_LANGUAGE_CODES].sort());
  });
});

describe('detectLanguageFromText', () => {

  describe('returns eng for English or insufficient text', () => {
    it('returns eng for null/empty input', () => {
      expect(detectLanguageFromText(null)).toBe('eng');
      expect(detectLanguageFromText('')).toBe('eng');
    });

    it('returns eng for text too short to analyze', () => {
      expect(detectLanguageFromText('Hello world')).toBe('eng');
    });

    it('returns eng for plain English text', () => {
      const text = 'The patient was examined and found to be in good health. Blood pressure was normal and all vital signs were stable.';
      expect(detectLanguageFromText(text)).toBe('eng');
    });

    it('returns eng for English text with occasional accents', () => {
      // Words like café, naïve, résumé shouldn't trigger French
      const text = 'We went to the café for a résumé review. The naïve approach was to simply ignore the problem entirely.';
      expect(detectLanguageFromText(text)).toBe('eng');
    });
  });

  describe('detects Italian', () => {
    it('detects Italian from accented characters', () => {
      const text = 'Il paziente è stato visitato presso il nostro ambulatorio. La diagnosi è stata confermata dopo ulteriori esami.';
      expect(detectLanguageFromText(text)).toBe('ita');
    });

    it('detects Italian from function words', () => {
      const text = 'Il certificato della protesi del braccio con tutti i dettagli del paziente nella cartella clinica sono stati verificati.';
      expect(detectLanguageFromText(text)).toBe('ita');
    });

    it('detects Italian medical text', () => {
      const text = 'DIPARTIMENTO DI ORTOPEDIA E TRAUMATOLOGIA RIABILITAZIONE. Diagnosi di dimissione: frattura prossimale omero sinistro.';
      expect(detectLanguageFromText(text)).toBe('ita');
    });
  });

  describe('detects French', () => {
    it('detects French from accented characters', () => {
      const text = 'Le médecin a examiné le patient. Les résultats étaient satisfaisants et la guérison se poursuit normalement.';
      expect(detectLanguageFromText(text)).toBe('fra');
    });

    it('detects French from function words', () => {
      const text = 'Les documents sont dans le dossier pour cette consultation avec tous les résultats des analyses.';
      expect(detectLanguageFromText(text)).toBe('fra');
    });
  });

  describe('detects German', () => {
    it('detects German from umlauts and ß', () => {
      const text = 'Der Patient wurde gründlich untersucht. Die Ergebnisse der Blutuntersuchung waren größtenteils unauffällig.';
      expect(detectLanguageFromText(text)).toBe('deu');
    });

    it('detects German from function words', () => {
      const text = 'Der Arzt hat den Befund mit dem Patienten besprochen und die weitere Behandlung wird nach den Ergebnissen geplant.';
      expect(detectLanguageFromText(text)).toBe('deu');
    });
  });

  describe('detects Spanish', () => {
    it('detects Spanish from ñ and inverted punctuation', () => {
      const text = '¿Cómo se encuentra el paciente? El niño tiene una pequeña lesión en el brazo. Mañana haremos los análisis.';
      expect(detectLanguageFromText(text)).toBe('spa');
    });

    it('detects Spanish from function words', () => {
      const text = 'El certificado del paciente con todos los datos de la consulta para este caso son los resultados del hospital.';
      expect(detectLanguageFromText(text)).toBe('spa');
    });
  });

  describe('detects Portuguese', () => {
    it('detects Portuguese from ã and õ', () => {
      const text = 'A avaliação do paciente foi concluída. As condições de saúde são boas e a recuperação está em andamento.';
      expect(detectLanguageFromText(text)).toBe('por');
    });
  });

  describe('detects non-Latin scripts', () => {
    it('detects Russian (Cyrillic)', () => {
      const text = 'Пациент был осмотрен врачом. Результаты анализов показали нормальные значения всех параметров крови.';
      expect(detectLanguageFromText(text)).toBe('rus');
    });

    it('detects Japanese (has hiragana/katakana)', () => {
      const text = '患者は医師によって診察されました。検査の結果は正常でした。';
      expect(detectLanguageFromText(text)).toBe('jpn');
    });

    it('detects Chinese (CJK without kana)', () => {
      const text = '患者已经接受了医生的检查。所有检查结果均在正常范围内。血压和心率都正常。';
      expect(detectLanguageFromText(text)).toBe('chi_sim');
    });

    it('detects Arabic', () => {
      const text = 'تم فحص المريض من قبل الطبيب. وكانت نتائج التحاليل طبيعية وجميع المؤشرات الحيوية مستقرة.';
      expect(detectLanguageFromText(text)).toBe('ara');
    });
  });
});

describe('getNavigatorLanguage', () => {
  it('returns null when navigator.languages is English-only', () => {
    vi.stubGlobal('navigator', { languages: ['en-US'] });
    expect(getNavigatorLanguage()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns ita for Italian system', () => {
    vi.stubGlobal('navigator', { languages: ['it-IT', 'en-US'] });
    expect(getNavigatorLanguage()).toBe('ita');
    vi.unstubAllGlobals();
  });

  it('returns deu for German system', () => {
    vi.stubGlobal('navigator', { languages: ['de-DE', 'en-GB'] });
    expect(getNavigatorLanguage()).toBe('deu');
    vi.unstubAllGlobals();
  });

  it('skips English and returns second language', () => {
    vi.stubGlobal('navigator', { languages: ['en-US', 'fr-FR'] });
    expect(getNavigatorLanguage()).toBe('fra');
    vi.unstubAllGlobals();
  });

  it('returns null when navigator is unavailable', () => {
    vi.stubGlobal('navigator', {});
    expect(getNavigatorLanguage()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('handles regional variants', () => {
    vi.stubGlobal('navigator', { languages: ['pt-BR', 'en-US'] });
    expect(getNavigatorLanguage()).toBe('por');
    vi.unstubAllGlobals();
  });
});
