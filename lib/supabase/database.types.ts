/**
 * lib/supabase/database.types.ts
 * Hand-written TypeScript types matching the Supabase schema.
 * Replace with output from: npx supabase gen types typescript --linked
 */
export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      items: {
        Row: {
          id:          string;
          user_id:     string;
          name:        string;
          category:    string | null;
          subcategory: string | null;
          location:    string;
          notes:       string | null;
          embedding:   number[] | null;
          created_at:  string;
          updated_at:  string;
        };
        Insert: {
          id?:         string;
          user_id:     string;
          name:        string;
          category?:   string | null;
          subcategory?: string | null;
          location:    string;
          notes?:      string | null;
          embedding?:  number[] | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?:         string;
          user_id?:    string;
          name?:       string;
          category?:   string | null;
          subcategory?: string | null;
          location?:   string;
          notes?:      string | null;
          embedding?:  number[] | null;
          updated_at?: string;
        };
      };
      user_settings: {
        Row: {
          user_id:      string;
          openai_model: string;
          created_at:   string;
          updated_at:   string;
        };
        Insert: {
          user_id:       string;
          openai_model?: string;
          created_at?:   string;
          updated_at?:   string;
        };
        Update: {
          openai_model?: string;
          updated_at?:   string;
        };
      };
      whitelist: {
        Row: {
          id:         string;
          email:      string;
          full_name:  string | null;
          notes:      string | null;
          is_active:  boolean;
          created_at: string;
        };
        Insert: {
          id?:         string;
          email:      string;
          full_name?:  string | null;
          notes?:      string | null;
          is_active?:  boolean;
          created_at?: string;
        };
        Update: {
          id?:         string;
          email?:      string;
          full_name?:  string | null;
          notes?:      string | null;
          is_active?:  boolean;
        };
      };
    };
    Views:     Record<string, never>;
    Functions: {
      check_whitelist: {
        Args: {
          p_email: string;
        };
        Returns: boolean;
      };
    };
    Enums:     Record<string, never>;
  };
}
