-- An eighth reaction to comments: ❌ `cancel` (Cancel).
alter table comment_reactions drop constraint comment_reactions_reaction_check;
alter table comment_reactions add constraint comment_reactions_reaction_check
  check (reaction in ('love', 'like', 'haha', 'wow', 'yum', 'fire', 'sad', 'cancel'));
