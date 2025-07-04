import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase';
import { toast } from 'sonner';
import { addActivity, updateWordsLearned } from '@/utils/activityLogger';

export interface FlashcardWord {
  id: string;
  german: string;
  english: string;
  example: string | null;
  status: 'learning' | 'familiar' | 'mastered';
  isOptimistic?: boolean;
  last_reviewed?: string | null;
}

interface ReviewStats {
  learning: number;
  familiar: number;
  mastered: number;
  dueForReview: number;
  reviewedToday: number;
  total: number;
}

type Mode = 'dashboard' | 'review' | 'browse';

export const useFlashcards = () => {
  const [allWords, setAllWords] = useState<FlashcardWord[]>([]);
  const [reviewWords, setReviewWords] = useState<FlashcardWord[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [browseIndex, setBrowseIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewComplete, setReviewComplete] = useState(false);
  const [mode, setMode] = useState<Mode>('dashboard');
  const [reviewStats, setReviewStats] = useState<ReviewStats>({
    learning: 0,
    familiar: 0,
    mastered: 0,
    dueForReview: 0,
    reviewedToday: 0,
    total: 0,
  });
  const [reviewedWords, setReviewedWords] = useState<{ word: string; status: string }[]>([]);

  const supabase = createClient();

  const fetchWords = useCallback(async () => {
    try {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be logged in to review flashcards');
        return;
      }

      const { data, error } = await supabase
        .from('vocabulary_words')
        .select('id, german, english, example, status, last_reviewed')
        .eq('user_id', user.id)
        .order('german', { ascending: true });

      if (error) throw error;

      const words = data || [];
      const wordsForReview = words.filter(
        (word) => word.status === 'learning' || word.status === 'familiar'
      );

      const today = new Date().toDateString();
      const reviewedToday = words.filter(
        (word) =>
          word.last_reviewed &&
          new Date(word.last_reviewed).toDateString() === today
      ).length;

      const stats = {
        learning: words.filter((w) => w.status === 'learning').length,
        familiar: words.filter((w) => w.status === 'familiar').length,
        mastered: words.filter((w) => w.status === 'mastered').length,
        dueForReview: wordsForReview.length,
        reviewedToday: reviewedToday,
        total: words.length,
      };

      setAllWords(words);
      setReviewWords(wordsForReview);
      setReviewStats(stats);
      setError(null);
    } catch (err) {
      console.error('Error fetching flashcards:', err);
      setError('Failed to load flashcards');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  const updateWordStatus = useCallback(
    async (id: string, newStatus: 'learning' | 'familiar' | 'mastered') => {
      const originalWord = allWords.find((word) => word.id === id);
      if (!originalWord) return;

      try {
        const updatedWord = {
          ...originalWord,
          status: newStatus,
          isOptimistic: true,
        };

        setAllWords((prev) =>
          prev.map((word) => (word.id === id ? updatedWord : word))
        );
        setReviewWords((prev) =>
          prev.map((word) => (word.id === id ? updatedWord : word))
        );

        setReviewStats((prev) => ({
          ...prev,
          [originalWord.status]: Math.max(
            0,
            prev[originalWord.status as keyof ReviewStats] - 1
          ),
          [newStatus]: prev[newStatus as keyof ReviewStats] + 1,
          reviewedToday: prev.reviewedToday + 1,
          dueForReview:
            newStatus === 'mastered' ? Math.max(0, prev.dueForReview - 1) : prev.dueForReview,
        }));

        // Track reviewed words for activity logging
        setReviewedWords((prev) => [
          ...prev,
          { word: originalWord.german, status: newStatus.charAt(0).toUpperCase() + newStatus.slice(1) },
        ]);

        // Move to next card after updating the state
        setFlipped(false);
        if (currentIndex < reviewWords.length - 1) {
          setCurrentIndex(currentIndex + 1);
        } else {
          setReviewComplete(true);
        }

        const { error } = await supabase
          .from('vocabulary_words')
          .update({
            status: newStatus,
            last_reviewed: new Date().toISOString(),
          })
          .eq('id', id);

        if (error) throw error;

        // If the new status is 'mastered', update words_learned in user_stats
        if (newStatus === 'mastered') {
          const masteredCount = allWords.filter((w) =>
            w.id === id ? newStatus === 'mastered' : w.status === 'mastered'
          ).length;
          await updateWordsLearned(masteredCount);
        }

        setAllWords((prev) =>
          prev.map((word) =>
            word.id === id ? { ...word, isOptimistic: false } : word
          )
        );
        setReviewWords((prev) =>
          prev.map((word) =>
            word.id === id ? { ...word, isOptimistic: false } : word
          )
        );
      } catch (error) {
        console.error('Error updating word status:', error);
        setAllWords((prev) =>
          prev.map((word) =>
            word.id === id ? { ...originalWord, isOptimistic: false } : word
          )
        );
        setReviewWords((prev) =>
          prev.map((word) =>
            word.id === id ? { ...originalWord, isOptimistic: false } : word
          )
        );

        setReviewStats((prev) => ({
          ...prev,
          [originalWord.status]: prev[originalWord.status as keyof ReviewStats] + 1,
          [newStatus]: Math.max(0, prev[newStatus as keyof ReviewStats] - 1),
          reviewedToday: Math.max(0, prev.reviewedToday - 1),
          dueForReview:
            newStatus === 'mastered' ? prev.dueForReview + 1 : prev.dueForReview,
        }));

        setError('Failed to update word status');
        toast.error('Failed to update word status');
      }
    },
    [allWords, supabase, currentIndex, reviewWords.length]
  );

  const resetReview = useCallback(() => {
    setCurrentIndex(0);
    setFlipped(false);
    setReviewComplete(false);
    fetchWords();
  }, [fetchWords]);

  const startReview = useCallback(() => {
    if (reviewWords.length === 0) {
      toast.error('No cards available to review. Add some words first!');
      return;
    }
    setMode('review');
    setCurrentIndex(0);
    setFlipped(false);
    setReviewComplete(false);
  }, [reviewWords.length]);

  const startBrowse = useCallback(() => {
    if (allWords.length === 0) {
      toast.error('No cards available to browse. Add some words first!');
      return;
    }
    setMode('browse');
    setBrowseIndex(0);
    setFlipped(false);
  }, [allWords.length]);

  const goToDashboard = useCallback(() => {
    setMode('dashboard');
    setFlipped(false);
  }, []);

  // Helper function to get the count of words to review
  const getReviewWordsCount = useCallback(() => {
    return reviewWords.length;
  }, [reviewWords.length]);

  // Log activity at the end of review session
  useEffect(() => {
    const logReviewActivity = async () => {
      if (reviewComplete && reviewedWords.length > 0) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const summary = `Finished Review Session: ${reviewedWords.length} word${reviewedWords.length === 1 ? '' : 's'} reviewed`;
        await addActivity('flashcard_review', summary);
        setReviewedWords([]); // Reset for next session
      }
    };
    logReviewActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewComplete]);

  useEffect(() => {
    fetchWords();
  }, [fetchWords]);

  return {
    // State
    allWords,
    reviewWords,
    currentIndex,
    browseIndex,
    flipped,
    loading,
    error,
    reviewComplete,
    setReviewComplete,
    mode,
    reviewStats,
    
    // Actions
    setFlipped,
    setMode,
    setBrowseIndex,
    updateWordStatus,
    resetReview,
    startReview,
    startBrowse,
    goToDashboard,
    fetchWords,
    getReviewWordsCount, // Added helper function
  };
};