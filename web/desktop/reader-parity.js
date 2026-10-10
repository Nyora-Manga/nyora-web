export const chapterBranch = chapter => chapter?.branch ?? '';
export function chaptersForBranch(chapters, chapterUrl) {
  const current = chapters.find(chapter=>chapter.url===chapterUrl);
  return current ? chapters.filter(chapter=>chapterBranch(chapter)===chapterBranch(current)) : chapters;
}
export function nearestSlide(track, slides, vertical) {
  const centre = rect => vertical ? rect.top+rect.height/2 : rect.left+rect.width/2;
  let best=0, distance=Infinity;
  for(const [index,slide] of slides.entries()) {
    const next=Math.abs(centre(slide)-centre(track));
    if(next<distance){best=index;distance=next;}
  }
  return best;
}
